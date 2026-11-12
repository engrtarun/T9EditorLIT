package api

// The local measurement pass.
//
// Everything in this file is free and local: the daemon reads the same 16 kHz
// mono WAV chunks the transcription will use, measures them once, and hands
// the numbers to the app. No upload, no model, no second decode.
//
// Why the app asks the daemon and not FFmpeg: the cut map (which decides
// what is dead air) and the upload gate (which decides what is worth paying
// for) have to agree about what "silence" means. Two thresholds - one fixed
// at -30 dB and one measured - would cut in one place and keep in another.
// One measurement, many consumers.

import (
	"errors"
	"net/http"
	"sort"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/vad"
)

// AudioProfileRequest is the body of POST /v1/audio-profile.
type AudioProfileRequest struct {
	SourcePath string               `json:"source_path"`
	Chunks     []model.ChunkRequest `json:"chunks"`
	// Sensitivity picks the margin above the measured noise floor:
	// "conservative", "balanced" or "aggressive". Empty means balanced.
	Sensitivity string `json:"sensitivity,omitempty"`
}

// handleAudioProfile measures a source's audio and answers with the profile.
//
// The app calls this before the cut map, so the silence threshold it uses is
// measured for that file instead of being a number somebody typed once.
func (s *Server) handleAudioProfile(w http.ResponseWriter, r *http.Request) {
	var req AudioProfileRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Chunks) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "at least one chunk is required",
		})
		return
	}

	profile, err := measureProfile(req.Chunks, req.Sensitivity)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, profile)
}

// sensitivityFor maps the UI's dial onto the scanner's options.
//
// An unknown value is not an error: it means "the caller did not choose",
// and the balanced default is the right answer for that.
func sensitivityFor(raw string) vad.Sensitivity {
	switch vad.Sensitivity(strings.ToLower(strings.TrimSpace(raw))) {
	case vad.SensitivityConservative:
		return vad.SensitivityConservative
	case vad.SensitivityAggressive:
		return vad.SensitivityAggressive
	default:
		return vad.SensitivityBalanced
	}
}

// asmrFloorDB is the absolute floor the conservative dial uses.
//
// -56 dBFS is the default: below it, what we hear is the microphone's own
// hiss rather than content. But a whisper sits *below* that line, and a
// whispered recording is real speech that must not be thrown away - so the
// conservative dial also lowers the floor.
//
// This is the ASMR mode of the edge cases, and it is the only place in the
// app where a threshold is lowered rather than raised.
const asmrFloorDB = -70.0

// scanOptions is the scanner configuration for a sensitivity dial.
//
// The dial moves two things together: the margin above the measured floor
// (how far above the room tone a frame has to sit) and, on the conservative
// setting, the absolute floor itself (whether a whisper counts as sound at
// all). Both point the same way - keep what is quiet.
func scanOptions(sensitivity string) vad.Options {
	opt := vad.Options{Sensitivity: sensitivityFor(sensitivity)}
	if opt.Sensitivity == vad.SensitivityConservative {
		floor := asmrFloorDB
		opt.AbsFloorOverride = &floor
	}
	return opt
}

// measureProfile scans every chunk and folds the results into one profile.
//
// The per-chunk numbers are folded with a median, not a mean: one chunk that
// happens to sit in a loud passage must not raise the file's noise floor, and
// one chunk that sat in digital silence must not lower it either. The median
// of ten five-minute chunks is the room tone of the recording.
//
// A chunk that cannot be read is skipped, and the profile says how many were
// measured. A profile built from three of ten chunks is a sample, and the UI
// needs to be able to say so.
func measureProfile(chunks []model.ChunkRequest, sensitivity string) (*model.AudioProfile, error) {
	opt := scanOptions(sensitivity)

	floors := make([]float64, 0, len(chunks))
	speeches := make([]float64, 0, len(chunks))

	var (
		duration float64
		audible  float64
		peakDB   = -120.0
		measured int
	)

	for _, c := range chunks {
		scan, err := vad.ScanWith(c.Path, opt)
		if err != nil {
			// A chunk that cannot be read is not a failure of the whole
			// measurement: the rest of the file still measures.
			continue
		}
		measured++
		duration += scan.DurationSecs()
		audible += scan.AudibleSecs()
		floors = append(floors, scan.NoiseFloorDB())
		speeches = append(speeches, scan.SpeechDB())
		if p := scan.PeakDB(); p > peakDB {
			peakDB = p
		}
	}

	if measured == 0 {
		return nil, errNoMeasurableAudio
	}

	floor := median(floors)
	speech := median(speeches)
	threshold := vad.ThresholdDB(floor, speech, opt.AbsFloorDB(), opt.MarginDB())

	profile := &model.AudioProfile{
		DurationSecs:       round3(duration),
		AudibleSecs:        round3(audible),
		SpeechRatio:        0,
		NoiseFloorDB:       round3(floor),
		SpeechDB:           round3(speech),
		SNRDB:              round3(speech - floor),
		PeakDB:             round3(peakDB),
		ThresholdDB:        round3(threshold),
		MarginDB:           round3(opt.MarginDB()),
		Sensitivity:        string(opt.Sensitivity),
		SilenceThresholdDB: round3(threshold),
		Chunks:             len(chunks),
		Measured:           measured,
	}
	if duration > 0 {
		profile.SpeechRatio = round3(audible / duration)
	}
	return profile, nil
}

// median is the middle value of a slice.
//
// An even count averages the two middle values: with ten chunks that is the
// mean of the fifth and the sixth, which is still far more robust than a
// mean over every chunk.
func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// round3 trims float noise so the numbers round-trip predictably through
// JSON and read the same in the UI and in the log.
func round3(v float64) float64 {
	return float64(int64(v*1000+0.5)) / 1000
}

// errNoMeasurableAudio is what the app sees when not one chunk could be
// read. It is a bad gateway rather than a server error: the daemon is fine,
// the input was not.
var errNoMeasurableAudio = errors.New("no audio chunk could be read")

// musicProbeChunks is how many chunks in a row may come back with sound but
// no words before the job calls the file music.
//
// Two, not one: a video that opens with a title card, a disclaimer and a
// pause produces exactly one wordless chunk with sound in it, and calling
// that "music" would throw away the forty minutes that follow.
const musicProbeChunks = 2

// musicSpeechRatio is how much of the file has to carry sound for the
// "no words in a row" signal to mean music.
//
// A music track is loud all the way through, so its audible ratio is high.
// A talking video with a silent opening has a low one, and the wordless
// chunks there are gaps, not music.
const musicSpeechRatio = 0.4

// musicLikely reports whether the profile looks like a music bed.
//
// The profile may be nil - when no chunk could be read there is no evidence
// either way, and the answer has to be "no".
func musicLikely(profile *model.AudioProfile) bool {
	if profile == nil {
		return false
	}
	return profile.SpeechRatio >= musicSpeechRatio
}
