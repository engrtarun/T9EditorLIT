package api

import (
	"encoding/binary"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

const profileRate = 16000

// writeProfileChunk builds a mono 16 kHz 16-bit PCM WAV: the exact format the
// Rust side hands the daemon as `chunk_000.wav`.
func writeProfileChunk(t *testing.T, secs int, toneDB, speechDB float64, speechFrom, speechTo float64) string {
	t.Helper()

	samples := make([]int16, secs*profileRate)
	tone := int16(32767 * math.Pow(10, toneDB/20))
	speech := int16(32767 * math.Pow(10, speechDB/20))
	for i := range samples {
		samples[i] = tone
	}
	for i := int(speechFrom * profileRate); i < int(speechTo*profileRate) && i < len(samples); i++ {
		samples[i] = speech
	}

	dataSize := len(samples) * 2
	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:], 16)
	binary.LittleEndian.PutUint16(buf[20:], 1)
	binary.LittleEndian.PutUint16(buf[22:], 1)
	binary.LittleEndian.PutUint32(buf[24:], profileRate)
	binary.LittleEndian.PutUint32(buf[28:], profileRate*2)
	binary.LittleEndian.PutUint16(buf[32:], 2)
	binary.LittleEndian.PutUint16(buf[34:], 16)
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:], uint32(dataSize))
	for i, s := range samples {
		binary.LittleEndian.PutUint16(buf[44+i*2:], uint16(s))
	}

	path := filepath.Join(t.TempDir(), "chunk.wav")
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The whole point of the profile: the numbers the cut map and the UI need,
// measured for this file instead of guessed.
func TestTheProfileMeasuresTheFileItself(t *testing.T) {
	// A phone recording next to a fan: room tone at -28 dBFS, speech at -6.
	path := writeProfileChunk(t, 20, -28, -6, 5, 15)

	profile, err := measureProfile([]model.ChunkRequest{{Path: path}}, "balanced")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}

	if profile.NoiseFloorDB > -25 || profile.NoiseFloorDB < -31 {
		t.Errorf("noise floor = %.1f dBFS, want about -28", profile.NoiseFloorDB)
	}
	if profile.SpeechDB < -8 || profile.SpeechDB > -4 {
		t.Errorf("speech level = %.1f dBFS, want about -6", profile.SpeechDB)
	}
	if profile.SNRDB < 18 || profile.SNRDB > 26 {
		t.Errorf("SNR = %.1f dB, want about 22", profile.SNRDB)
	}
	// 10 s of speech in 20 s of file.
	if profile.SpeechRatio < 0.4 || profile.SpeechRatio > 0.6 {
		t.Errorf("speech ratio = %.2f, want about 0.5", profile.SpeechRatio)
	}
	// The threshold has to sit between the floor and the speech.
	if profile.ThresholdDB <= profile.NoiseFloorDB {
		t.Errorf("threshold %.1f must sit above the floor %.1f",
			profile.ThresholdDB, profile.NoiseFloorDB)
	}
	if profile.ThresholdDB >= profile.SpeechDB {
		t.Errorf("threshold %.1f must sit below the speech %.1f",
			profile.ThresholdDB, profile.SpeechDB)
	}
	// The cut map uses this number instead of a fixed -30 dB.
	if profile.SilenceThresholdDB != profile.ThresholdDB {
		t.Errorf("silence threshold %.1f must be the measured threshold %.1f",
			profile.SilenceThresholdDB, profile.ThresholdDB)
	}
}

// The sensitivity dial has to move the file-level threshold too, not only the
// per-chunk one.
func TestTheProfileHonoursTheSensitivityDial(t *testing.T) {
	path := writeProfileChunk(t, 20, -40, -14, 5, 15)

	conservative, err := measureProfile([]model.ChunkRequest{{Path: path}}, "conservative")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	aggressive, err := measureProfile([]model.ChunkRequest{{Path: path}}, "aggressive")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}

	if !(conservative.ThresholdDB < aggressive.ThresholdDB) {
		t.Errorf("conservative threshold %.1f must sit below aggressive %.1f",
			conservative.ThresholdDB, aggressive.ThresholdDB)
	}
	if conservative.Sensitivity != "conservative" {
		t.Errorf("sensitivity = %q, want the dial echoed back", conservative.Sensitivity)
	}
}

// An unknown dial is not an error: it means "the caller did not choose".
func TestAnUnknownSensitivityFallsBackToBalanced(t *testing.T) {
	path := writeProfileChunk(t, 5, -40, -14, 1, 4)

	profile, err := measureProfile([]model.ChunkRequest{{Path: path}}, "loud")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	if profile.Sensitivity != "balanced" {
		t.Errorf("sensitivity = %q, want balanced", profile.Sensitivity)
	}
}

// A chunk that cannot be read is skipped, and the profile says how many
// chunks it actually measured. A profile built from a sample must not look
// like a profile of the whole file.
func TestAnUnreadableChunkIsSkippedAndCounted(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "broken.wav")
	if err := os.WriteFile(bad, []byte("not audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	good := writeProfileChunk(t, 5, -40, -14, 1, 4)

	profile, err := measureProfile([]model.ChunkRequest{
		{Path: bad}, {Path: good},
	}, "balanced")
	if err != nil {
		t.Fatalf("profile: %v", err)
	}
	if profile.Chunks != 2 || profile.Measured != 1 {
		t.Errorf("chunks = %d, measured = %d, want 2 and 1", profile.Chunks, profile.Measured)
	}
}

// No chunk at all could be read: the caller has to be told, not handed an
// empty profile that looks like a silent file.
func TestAnUnmeasurableProfileIsAnError(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "broken.wav")
	if err := os.WriteFile(bad, []byte("not audio"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := measureProfile([]model.ChunkRequest{{Path: bad}}, "balanced"); err == nil {
		t.Error("a profile with nothing measured must be an error")
	}
}

// The endpoint answers with the profile, so the app can ask for the cut
// map's threshold before the transcription starts.
func TestTheAudioProfileEndpointAnswers(t *testing.T) {
	path := writeProfileChunk(t, 5, -40, -14, 1, 4)

	s, _ := newTestServer(t, baseConfig(), nil)
	body := jsonBody(t, AudioProfileRequest{
		SourcePath: "D:/videos/lecture.mp4",
		Chunks:     []model.ChunkRequest{{Path: path, Index: 0}},
	})
	rec := do(t, s, http.MethodPost, "/v1/audio-profile", body)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}

	var profile model.AudioProfile
	if err := json.Unmarshal(rec.Body.Bytes(), &profile); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if profile.Chunks != 1 || profile.Measured != 1 {
		t.Errorf("chunks = %d, measured = %d, want 1 and 1", profile.Chunks, profile.Measured)
	}
	if profile.SilenceThresholdDB == 0 {
		t.Error("the profile must carry the threshold the cut map should use")
	}
}

// A music bed is loud all the way through; a talking video with a silent
// opening is not. That difference is what stops the music verdict from
// firing on a video that simply opens quietly.
func TestMusicLikelyNeedsAFullFile(t *testing.T) {
	if musicLikely(nil) {
		t.Error("no profile means no evidence")
	}
	if musicLikely(&model.AudioProfile{SpeechRatio: 0.1}) {
		t.Error("a mostly quiet file is not a music bed")
	}
	if !musicLikely(&model.AudioProfile{SpeechRatio: 0.9}) {
		t.Error("a file that is loud all the way through is a music bed")
	}
}
