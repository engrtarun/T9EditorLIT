// Package vad answers one question locally, before any money is spent on an
// upload: does this chunk contain anything a transcript could be made of?
//
// It is deliberately dumb. No model, no network, no dependency — just a
// streaming read of the PCM WAV the Rust side extracts (mono, 16 kHz, 16-bit)
// split into 10 ms frames, each classified audible or silent against a
// threshold measured from the file itself: the noise floor of this recording
// plus a margin. "Silence" is relative, and a fan at -28 dBFS and a studio at
// -60 dBFS need different numbers — one measurement, one threshold, many
// consumers.
//
// Two callers, both fail open: anything this scanner cannot read returns an
// error and the caller hands the chunk to the provider unchanged. A local
// scan must never be the reason a transcript is missing.
package vad

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
)

const (
	// frameMillis is the classification window. 10 ms tracks speech pauses
	// closely enough and keeps a 10-minute chunk at 60k frames (~0.5 MB).
	frameMillis = 10

	// absFloorDB is the quietest a frame can be and still count as sound,
	// in dBFS. Below this is hiss the microphone made, not content.
	absFloorDB = -56.0

	// minAudibleSecs / minContentSecs / minAudibleFraction are the "worth
	// uploading" bar. A duck meme measures 0.19 s of sound in 1.16 s and fails
	// the absolute floor.
	//
	// minContentSecs is the long-chunk answer. A 5-minute chunk from a screen
	// recording is routinely ~17% audible - 52 seconds of talking between
	// silent stretches - and the old fraction-only rule skipped it, taking the
	// middle of a 49-minute import with it. Missing real words is expensive; a
	// false positive costs one API call, so any chunk with a few seconds of
	// sound is transcribed regardless of how long the chunk is.
	minAudibleSecs     = 0.3
	minContentSecs     = 3.0
	minAudibleFraction = 0.2

	// segmentMinAudibleSecs / segmentAudibleFraction decide whether real
	// audio backs a claimed word. Whisper's phantom "What?" spanned
	// 0 → 0.9 s over a mostly silent file: 0.16 s of sound cannot back a
	// 0.9 s word (18%, under the bar).
	//
	// segmentLongSecs / segmentLongMinAudibleSecs cover the opposite bug.
	// Whisper stretches a segment from the chunk start to the first word it
	// heard, so a real sentence at 12-14 s of a 14 s span measured ~14% and
	// was dropped as "no audio behind it". A long line needs an absolute
	// amount of sound, not a share of a span the provider invented.
	segmentMinAudibleSecs  = 0.05
	segmentAudibleFraction = 0.25
	segmentLongSecs        = 3.0
	segmentLongMinAudible  = 1.0
)

// Sensitivity is the user-facing dial for how close to the noise floor a
// frame has to sit before it counts as silence.
//
// It is a *margin*, not a fixed threshold: the floor is measured per file
// (see Options.AbsFloorOverride and the noise-floor percentile below), and
// this decides how many dB above that floor the bar sits. That is the whole
// point of the edge-case playbook — "silence" is relative, and a fan at
// -28 dBFS and a studio at -60 dBFS need different numbers.
//
// The names describe what the user loses, not what the machine does:
//
//   - conservative → small margin, quiet speech survives, less dead air is cut
//   - balanced     → the default
//   - aggressive   → large margin, more dead air is cut, quiet speech is at risk
type Sensitivity string

const (
	SensitivityConservative Sensitivity = "conservative"
	SensitivityBalanced     Sensitivity = "balanced"
	SensitivityAggressive   Sensitivity = "aggressive"
)

// sensitivityMargin is how far above the measured noise floor the threshold
// sits, per sensitivity level.
//
// The numbers are the measured ones from the playbook: a studio recording has
// ~42 dB between room tone and speech, a phone recording in a fan's breeze
// about 22 dB. A 9 dB margin sits inside both; 3 dB is for ASMR and whisper
// (Case 20), where the speech itself barely rises above the floor; 18 dB is
// for a screen recording with long dead stretches and a hot signal.
var sensitivityMargin = map[Sensitivity]float64{
	SensitivityConservative: 3.0,
	SensitivityBalanced:     9.0,
	SensitivityAggressive:   18.0,
}

// minSpeechMarginDB is how far below the speech level the threshold is
// allowed to sit.
//
// This is the guard that keeps a quiet recording alive. If the measured floor
// and the measured speech level are the same (a uniformly quiet lecture, or a
// file with no silence at all), "floor + margin" would put the bar *above*
// the speech and every frame would be classified as silence — the exact
// failure the fixed -56 dB floor was introduced to prevent. The threshold is
// therefore never allowed above "speech level - this".
const minSpeechMarginDB = 3.0

// floorPercentile and speechPercentile pick the two ends of the level
// distribution.
//
// The floor is the 10th percentile of the frames that carry any signal at all:
// the quietest tenth of the file is room tone, and the 10% (not the median)
// is what makes a studio recording measure -60 dB instead of "whatever the
// quietest passing moment was". The speech level is the 95th percentile, high
// enough that ordinary speech peaks reach it even in a file that is 80% dead
// air.
const (
	floorPercentile  = 0.10
	speechPercentile = 0.95
)

// Options tunes one scan.
//
// The zero value is the behaviour the daemon has always had: the absolute
// floor, the balanced margin, no override. Every field is optional so a
// caller that has nothing to say passes nothing.
type Options struct {
	// Sensitivity picks the margin above the measured floor.
	Sensitivity Sensitivity
	// AbsFloorOverride replaces the absolute floor in dBFS. ASMR and whispered
	// recordings need a lower one (Case 20): -56 dBFS is already louder than
	// a whisper, so the absolute floor alone would call the whole file
	// silence.
	AbsFloorOverride *float64
}

// marginDB is the effective margin for these options.
func (o Options) marginDB() float64 {
	if m, ok := sensitivityMargin[o.Sensitivity]; ok {
		return m
	}
	return sensitivityMargin[SensitivityBalanced]
}

// MarginDB is how far above the noise floor the threshold will sit.
//
// Exported because the API layer folds several chunks into one file-level
// threshold and has to use the same rule the per-chunk scan used.
func (o Options) MarginDB() float64 { return o.marginDB() }

// absFloorDB is the effective absolute floor for these options.
func (o Options) absFloorDB() float64 {
	if o.AbsFloorOverride != nil {
		return *o.AbsFloorOverride
	}
	return absFloorDB
}

// AbsFloorDB is the absolute floor in force, in dBFS.
func (o Options) AbsFloorDB() float64 { return o.absFloorDB() }

// ThresholdDB is the exported form of the threshold rule.
//
// The API layer measures several chunks and needs one threshold for the file
// as a whole; it uses this so the file-level number is produced by exactly
// the same rule as the per-chunk ones.
func ThresholdDB(floorDB, speechDB, absFloor, margin float64) float64 {
	return thresholdFor(floorDB, speechDB, absFloor, margin)
}

// Result is the outcome of reading one chunk file. It is immutable after
// Scan returns and is safe to read from any goroutine.
type Result struct {
	rate        int
	frameN      int
	frameSec    float64
	durationSec float64
	peak        float64
	energies    []float64 // mean |sample| per frame, in amplitude units
	audible     []bool
	audibleSecs float64

	// The measured levels, in dBFS. All four come from the same pass over
	// the same frames — one measurement, many consumers (the edge-case
	// playbook's "pehle naapo, phir kaato" in its literal form).
	noiseFloorDB float64 // 10th percentile of the frames that carry signal
	speechDB     float64 // 95th percentile of the same frames
	thresholdDB  float64 // the bar a frame has to clear to count as sound
	marginDB     float64 // how far above the floor that bar sits
	absFloorDB   float64 // the absolute floor in force for this scan
}

// Scan reads path and measures its audio. It returns an error for anything
// that is not a mono/stereo 16-bit PCM RIFF/WAVE file with a data chunk —
// callers treat an error as "scan unavailable, send it to the provider".
func Scan(path string) (*Result, error) {
	return ScanWith(path, Options{})
}

// ScanWith is Scan with the measurement knobs turned.
//
// The options change the *decision*, never the measurement: the noise floor
// and the speech level are read the same way whatever the caller asks for.
func ScanWith(path string, opt Options) (*Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return scanWith(f, opt)
}

func scan(r io.Reader) (*Result, error) {
	return scanWith(r, Options{})
}

func scanWith(r io.Reader, opt Options) (*Result, error) {
	var head [12]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return nil, fmt.Errorf("vad: read header: %w", err)
	}
	if string(head[0:4]) != "RIFF" || string(head[8:12]) != "WAVE" {
		return nil, errors.New("vad: not a RIFF/WAVE file")
	}

	var (
		rate, channels, bits int
		haveFmt              bool
		data                 io.Reader
	)
	for {
		var chunk [8]byte
		if _, err := io.ReadFull(r, chunk[:]); err != nil {
			return nil, fmt.Errorf("vad: read chunk: %w", err)
		}
		id := string(chunk[0:4])
		size := int64(binary.LittleEndian.Uint32(chunk[4:]))
		pad := int64(0)
		if size%2 == 1 {
			pad = 1 // chunks are word-aligned
		}

		switch id {
		case "fmt ":
			if size < 16 || size > 4096 {
				return nil, fmt.Errorf("vad: absurd fmt chunk size %d", size)
			}
			buf := make([]byte, size)
			if _, err := io.ReadFull(r, buf); err != nil {
				return nil, fmt.Errorf("vad: read fmt: %w", err)
			}
			if binary.LittleEndian.Uint16(buf[0:2]) != 1 {
				return nil, fmt.Errorf("vad: unsupported codec %#x, want PCM",
					binary.LittleEndian.Uint16(buf[0:2]))
			}
			channels = int(binary.LittleEndian.Uint16(buf[2:4]))
			rate = int(binary.LittleEndian.Uint32(buf[4:8]))
			bits = int(binary.LittleEndian.Uint16(buf[14:16]))
			if channels < 1 || channels > 2 || rate < 8000 || rate > 192000 {
				return nil, fmt.Errorf("vad: bad fmt channels=%d rate=%d", channels, rate)
			}
			if bits != 16 {
				return nil, fmt.Errorf("vad: %d-bit samples, want 16", bits)
			}
			haveFmt = true
			if pad > 0 {
				if _, err := io.CopyN(io.Discard, r, pad); err != nil {
					return nil, err
				}
			}
		case "data":
			if !haveFmt {
				return nil, errors.New("vad: data chunk before fmt")
			}
			data = io.LimitReader(r, size)
			// Stop parsing: everything after data is metadata we do not need.
			goto measured
		default:
			if size > 0 {
				if _, err := io.CopyN(io.Discard, r, size+pad); err != nil {
					return nil, fmt.Errorf("vad: skip %q: %w", id, err)
				}
			}
		}
	}

measured:
	return measure(rate, data, opt)
}

// measure streams the PCM data once, keeping only per-frame mean absolute
// amplitude — a 10-minute chunk costs ~0.5 MB, never a sample buffer.
func measure(rate int, data io.Reader, opt Options) (*Result, error) {
	frameN := rate * frameMillis / 1000 // 10 ms at 16 kHz = 160 samples
	if frameN < 1 {
		frameN = 1
	}
	frameSec := float64(frameN) / float64(rate)

	buf := make([]byte, frameN*2)
	var (
		energies     []float64
		peak         float64
		totalSamples int64
	)
	for {
		n, err := io.ReadFull(data, buf)
		samples := n / 2
		if samples > 0 {
			var sum float64
			for i := 0; i < samples; i++ {
				v := float64(int16(binary.LittleEndian.Uint16(buf[i*2:])))
				if v < 0 {
					v = -v
				}
				sum += v
				if v > peak {
					peak = v
				}
			}
			energies = append(energies, sum/float64(samples))
			totalSamples += int64(samples)
		}
		if err != nil {
			// EOF or a short final frame: the samples we got are the audio
			// that exists. Anything else is handled by the caller failing open.
			break
		}
	}

	s := &Result{
		rate:        rate,
		frameN:      frameN,
		frameSec:    frameSec,
		durationSec: float64(totalSamples) / float64(rate),
		peak:        peak,
		energies:    energies,
		audible:     make([]bool, len(energies)),
		marginDB:    opt.marginDB(),
		absFloorDB:  opt.absFloorDB(),
	}

	// The measurement pass: one look at the frames, four numbers out of it.
	//
	// The old rule was "louder than the louder of -56 dBFS and 1/64th of the
	// peak". It is a peak-relative rule, and it is wrong for exactly the
	// files the edge-case playbook calls out: a phone recording next to a fan
	// has room tone at -28 dBFS, which is *above* -30 dB, so a fixed
	// threshold finds no silence at all and nothing is ever cut. A studio
	// recording has room tone at -60 dBFS, where a fixed -30 dB threshold
	// calls every breath silence and the video gets chopped.
	//
	// What replaces it measures the file's own floor and its own speech
	// level and puts the bar between them, a margin above the floor.
	s.noiseFloorDB, s.speechDB = measureLevels(energies, s.absFloorDB)
	s.thresholdDB = thresholdFor(s.noiseFloorDB, s.speechDB, s.absFloorDB, s.marginDB)

	threshold := 32767 * math.Pow(10, s.thresholdDB/20)
	for i, e := range energies {
		if e > threshold {
			s.audible[i] = true
			s.audibleSecs += frameSec
		}
	}
	return s, nil
}

// measureLevels returns the noise floor and the speech level of a chunk, both
// in dBFS.
//
// Only frames that carry any signal at all take part. A frame of digital
// silence is a *gap*, not room tone: letting those frames into the
// percentile would drag the floor of every file with gaps in it down to
// -Infinity, and the threshold that follows would then call the room tone
// audible - the exact opposite of what an adaptive threshold is for.
//
// A file with no signal at all (pure digital silence) reports the absolute
// floor for both, which makes the threshold the absolute floor and the whole
// file silent - the honest answer.
func measureLevels(energies []float64, absFloor float64) (floorDB, speechDB float64) {
	levels := make([]float64, 0, len(energies))
	for _, e := range energies {
		if e <= 0 {
			continue // digital silence: a gap, not a level
		}
		levels = append(levels, amplitudeDB(e))
	}
	if len(levels) == 0 {
		return absFloor, absFloor
	}
	sort.Float64s(levels)
	return percentile(levels, floorPercentile), percentile(levels, speechPercentile)
}

// thresholdFor puts the bar between the floor and the speech level.
//
// Two rules, both load-bearing:
//
//   - "floor + margin" is the intent: how far above the room tone a frame
//     has to sit to count as sound.
//   - never above "speech level - minSpeechMarginDB": in a file where the
//     floor and the speech level are the same - a uniformly quiet lecture, or
//     a file with no silence in it at all - the first rule alone would put
//     the bar *above* the speech and call the whole file silence.
//
// The absolute floor still applies as the lowest bar the threshold may take:
// below it, what we are hearing is the microphone's own noise, not content.
func thresholdFor(floorDB, speechDB, absFloor, margin float64) float64 {
	candidate := floorDB + margin
	if limit := speechDB - minSpeechMarginDB; candidate > limit {
		candidate = limit
	}
	if candidate < absFloor {
		candidate = absFloor
	}
	return candidate
}

// amplitudeDB converts a mean-absolute amplitude to dBFS.
func amplitudeDB(amplitude float64) float64 {
	if amplitude <= 0 {
		return -120 // digital silence, as far as the percentiles care
	}
	return 20 * math.Log10(amplitude/32767)
}

// percentile returns the p-th percentile of a sorted slice.
//
// The nearest-rank method: the smallest value at or above the p-th of the
// data. No interpolation, because an interpolated level is a level that was
// never measured.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return -120
	}
	if p <= 0 {
		return sorted[0]
	}
	if p >= 1 {
		return sorted[len(sorted)-1]
	}
	rank := int(math.Ceil(p*float64(len(sorted)))) - 1
	if rank < 0 {
		rank = 0
	}
	if rank >= len(sorted) {
		rank = len(sorted) - 1
	}
	return sorted[rank]
}

// DurationSecs is the length of audio actually read from the file.
func (s *Result) DurationSecs() float64 { return s.durationSec }

// AudibleSecs is how much of the chunk is louder than the threshold.
func (s *Result) AudibleSecs() float64 { return s.audibleSecs }

// NoiseFloorDB is the measured room tone of this recording, in dBFS.
//
// This is the number the edge-case playbook asks for: "the quietest
// percentile astats se" - except astats cannot answer it (it reports
// whole-file statistics, not a time series), so it is measured here, from the
// frames the scan already read.
func (s *Result) NoiseFloorDB() float64 { return s.noiseFloorDB }

// SpeechDB is the measured speech level of this recording, in dBFS.
func (s *Result) SpeechDB() float64 { return s.speechDB }

// ThresholdDB is the level a frame has to clear to count as sound.
func (s *Result) ThresholdDB() float64 { return s.thresholdDB }

// MarginDB is how far above the noise floor that threshold sits.
func (s *Result) MarginDB() float64 { return s.marginDB }

// PeakDB is the loudest moment in the file, in dBFS.
func (s *Result) PeakDB() float64 { return amplitudeDB(s.peak) }

// SNRDB is how far the speech sits above the room tone.
//
// This is the number that says "the voice is buried under the music bed"
// (Case 18) without anyone having to listen to the file: under ~8 dB the
// speech is fighting the background, over ~20 dB it is clean.
func (s *Result) SNRDB() float64 { return s.speechDB - s.noiseFloorDB }

// SpeechRatio is the share of the file that carries sound, 0..1.
//
// It is an *audible* ratio, not a "is there speech" verdict: music is loud
// too. It answers "how much of this file is not dead air", which is what the
// cut map and the music-project check need.
func (s *Result) SpeechRatio() float64 {
	if s.durationSec <= 0 {
		return 0
	}
	return s.audibleSecs / s.durationSec
}

// WorthTranscribing reports whether uploading this chunk could plausibly buy
// a transcript. Digital silence, a lone duck quack, a mostly-empty meme: no.
// False means "skip the API call entirely", never "invent a result".
func (s *Result) WorthTranscribing() bool {
	if s.audibleSecs < minAudibleSecs {
		return false
	}
	// A few seconds of sound is content no matter how long the chunk is.
	if s.audibleSecs >= minContentSecs {
		return true
	}
	return s.audibleSecs >= minAudibleFraction*s.durationSec
}

// AudibleIn returns the audible seconds inside [start, end), clamped to the
// chunk. Frames straddling a boundary count only if they start inside it, so
// a word's span is measured against exactly the audio it claims.
func (s *Result) AudibleIn(start, end float64) float64 {
	first, last := s.framesIn(start, end)
	count := 0
	for i := first; i < last; i++ {
		if s.audible[i] {
			count++
		}
	}
	return float64(count) * s.frameSec
}

// BacksSegment reports whether real audio exists where a transcript claims a
// word. Whisper invents words over silence ("What?" across a duck meme); a
// word that sits where there is no sound did not happen.
func (s *Result) BacksSegment(start, end float64) bool {
	if start < 0 {
		start = 0
	}
	if end > s.durationSec {
		end = s.durationSec
	}
	segDur := end - start
	if segDur <= 0 {
		return false
	}
	audible := s.AudibleIn(start, end)
	if audible < segmentMinAudibleSecs {
		return false
	}
	// Long spans get the absolute test. Whisper routinely begins a segment at
	// 0 s and ends it at the last word, so a real line at 12-14 s of a 14 s
	// span is 14% audible and used to be thrown away. One second of real sound
	// inside a long line is proof enough; the phantom case (a 4 s claim over
	// 0.9 s of noise) still fails.
	if segDur > segmentLongSecs {
		return audible >= segmentLongMinAudible
	}
	return audible >= segmentAudibleFraction*segDur
}

// framesIn converts a time range to the half-open frame range covering it.
func (s *Result) framesIn(start, end float64) (int, int) {
	if end <= start || len(s.energies) == 0 {
		return 0, 0
	}
	startSample := int64(math.Round(start * float64(s.rate)))
	endSample := int64(math.Round(end * float64(s.rate)))
	first := ceilDiv(startSample, int64(s.frameN))
	last := ceilDiv(endSample, int64(s.frameN))
	if first < 0 {
		first = 0
	}
	if last > int64(len(s.energies)) {
		last = int64(len(s.energies))
	}
	if last < first {
		last = first
	}
	return int(first), int(last)
}

func ceilDiv(a, b int64) int64 {
	if a <= 0 {
		return 0
	}
	return (a + b - 1) / b
}
