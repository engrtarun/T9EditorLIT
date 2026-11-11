// Package vad answers one question locally, before any money is spent on an
// upload: does this chunk contain anything a transcript could be made of?
//
// It is deliberately dumb. No model, no network, no dependency — just a
// streaming read of the PCM WAV the Rust side extracts (mono, 16 kHz, 16-bit)
// split into 10 ms frames, each classified audible or silent against a
// threshold that is the louder of an absolute floor and a fraction of the
// file's own peak. Peak-relative matters: a lecture recorded quietly is not
// silence, and must never be skipped.
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
)

const (
	// frameMillis is the classification window. 10 ms tracks speech pauses
	// closely enough and keeps a 10-minute chunk at 60k frames (~0.5 MB).
	frameMillis = 10

	// absFloorDB is the quietest a frame can be and still count as sound,
	// in dBFS. Below this is hiss the microphone made, not content.
	absFloorDB = -54.0

	// peakRatio caps the threshold at 1/40th of the file's own peak, so
	// one loud clap cannot make the quiet speech around it vanish.
	peakRatio = 40.0

	// minAudibleSecs / minAudibleFraction are the "worth uploading" bar.
	// A chunk with under 300 ms of sound — or under 20% sound — carries
	// nothing Whisper could turn into words. The duck meme measures
	// 0.19 s of sound in 1.16 s and fails both.
	minAudibleSecs     = 0.3
	minAudibleFraction = 0.2

	// segmentMinAudibleSecs / segmentAudibleFraction decide whether real
	// audio backs a claimed word. Whisper's phantom "What?" spanned
	// 0 → 0.9 s over a mostly silent file: 0.15 s of sound cannot back a
	// 0.9 s word (17%, under the bar). The bar sits low on purpose — a
	// real line with a long trailing pause must survive; dropping a true
	// word would be worse than keeping a doubtful one.
	segmentMinAudibleSecs  = 0.05
	segmentAudibleFraction = 0.25
)

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
}

// Scan reads path and measures its audio. It returns an error for anything
// that is not a mono/stereo 16-bit PCM RIFF/WAVE file with a data chunk —
// callers treat an error as "scan unavailable, send it to the provider".
func Scan(path string) (*Result, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return scan(f)
}

func scan(r io.Reader) (*Result, error) {
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
	return measure(rate, data)
}

// measure streams the PCM data once, keeping only per-frame mean absolute
// amplitude — a 10-minute chunk costs ~0.5 MB, never a sample buffer.
func measure(rate int, data io.Reader) (*Result, error) {
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
	}

	threshold := 32767 * math.Pow(10, absFloorDB/20)
	if rel := peak / peakRatio; rel > threshold {
		threshold = rel
	}
	for i, e := range energies {
		if e > threshold {
			s.audible[i] = true
			s.audibleSecs += frameSec
		}
	}
	return s, nil
}

// DurationSecs is the length of audio actually read from the file.
func (s *Result) DurationSecs() float64 { return s.durationSec }

// AudibleSecs is how much of the chunk is louder than the threshold.
func (s *Result) AudibleSecs() float64 { return s.audibleSecs }

// WorthTranscribing reports whether uploading this chunk could plausibly buy
// a transcript. Digital silence, a lone duck quack, a mostly-empty meme: no.
// False means "skip the API call entirely", never "invent a result".
func (s *Result) WorthTranscribing() bool {
	if s.audibleSecs < minAudibleSecs {
		return false
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
