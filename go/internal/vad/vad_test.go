package vad

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

// testRate is the sample rate the Rust side extracts chunks at (mono, 16 kHz).
const testRate = 16000

// writeWAV builds a mono 16-bit PCM WAV — byte-for-byte the format the Rust
// side hands the daemon as `chunk_000.wav`.
func writeWAV(t *testing.T, samples []int16) string {
	t.Helper()

	dataSize := len(samples) * 2
	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:], 16)
	binary.LittleEndian.PutUint16(buf[20:], 1) // PCM
	binary.LittleEndian.PutUint16(buf[22:], 1) // mono
	binary.LittleEndian.PutUint32(buf[24:], testRate)
	binary.LittleEndian.PutUint32(buf[28:], testRate*2)
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

// duckMeme reproduces the file behind the bug report: "Duck Meme Hd
// Template.mp4" is 1.16 s long and its audio is digital silence except for a
// single 190 ms quack between 0.751 s and 0.943 s (measured with
// silencedetect: mean -25.2 dB, max -7.1 dB, everything else -inf).
func duckMeme(t *testing.T) string {
	t.Helper()

	const n = 18576 // 1.161 s at 16 kHz
	samples := make([]int16, n)
	for i := 12000; i < 15000; i++ {
		samples[i] = 8000
	}
	return writeWAV(t, samples)
}

// The bug: this clip was uploaded to Whisper, which confidently invented a
// line reading "What?" for a duck quack. The device can see there is barely
// any sound here at all, so the call must never happen.
func TestDuckMemeChunkIsNotWorthAnAPICall(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if d := s.DurationSecs(); d < 1.1 || d > 1.2 {
		t.Errorf("duration = %.3f s, want ~1.16 s", d)
	}
	if a := s.AudibleSecs(); a < 0.15 || a > 0.30 {
		t.Errorf("audible = %.3f s, want ~0.2 s (silence plus one quack)", a)
	}
	if s.WorthTranscribing() {
		t.Error("a 1.16 s meme with 0.2 s of sound must not be worth an API call")
	}
}

func TestChunkFullOfSoundIsWorthAnAPICall(t *testing.T) {
	samples := make([]int16, 2*testRate)
	for i := range samples {
		samples[i] = 5000
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !s.WorthTranscribing() {
		t.Errorf("audible %.2f s of %.2f s must be worth transcribing",
			s.AudibleSecs(), s.DurationSecs())
	}
}

func TestPureDigitalSilenceHasNoAudibleSeconds(t *testing.T) {
	s, err := Scan(writeWAV(t, make([]int16, 2*testRate)))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if a := s.AudibleSecs(); a != 0 {
		t.Errorf("audible = %.3f s, want 0 for digital silence", a)
	}
	if s.WorthTranscribing() {
		t.Error("silence must never be worth an API call")
	}
}

// A quiet recording must not be mistaken for silence: the scan also honours a
// peak-relative threshold, so a lecture recorded at -50 dBFS still counts.
func TestQuietRecordingIsNotSkippedAsSilence(t *testing.T) {
	samples := make([]int16, 3*testRate)
	for i := range samples {
		samples[i] = 150 // ≈ -47 dBFS peak — quiet, but real
	}

	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if !s.WorthTranscribing() {
		t.Errorf("a quiet 3 s recording (audible %.2f s) must not be skipped as silence",
			s.AudibleSecs())
	}
}

// The hallucination guard: Whisper claimed "What?" spans 0 → 0.9 s, but the
// audio there is silent until 0.751 s. A word that sits where there is no
// sound did not happen.
func TestPhantomWordOverSilenceIsNotBackedByAudio(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if s.BacksSegment(0.0, 0.9) {
		t.Error("0→0.9 s contains 0.16 s of sound — that cannot back a word")
	}
}

func TestWordOverRealAudioIsBackedByAudio(t *testing.T) {
	s, err := Scan(duckMeme(t))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	// 0.75→0.94 s is exactly where the quack is: short, but fully real.
	if !s.BacksSegment(0.75, 0.94) {
		t.Error("the span holding the actual sound must be backed by audio")
	}
}

func TestAudibleWindowCountsOnlyFramesInsideIt(t *testing.T) {
	// Loud for 2 s, silent for 2 s.
	samples := make([]int16, 4*testRate)
	for i := 0; i < 2*testRate; i++ {
		samples[i] = 8000
	}
	s, err := Scan(writeWAV(t, samples))
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	if got := s.AudibleIn(0, 2); got < 1.95 || got > 2.0 {
		t.Errorf("audible in loud half = %.2f s, want ~2.0", got)
	}
	if got := s.AudibleIn(2, 4); got != 0 {
		t.Errorf("audible in silent half = %.2f s, want 0", got)
	}
}

// Fail open: anything this scanner cannot read is handed to the provider
// unchanged. A local scan must never be the reason a transcript is missing.
func TestUnreadableFileIsAnErrorNotASkip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-wav.m4a")
	if err := os.WriteFile(path, []byte("fake audio"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := Scan(path); err == nil {
		t.Error("scanning a non-WAV file must return an error so callers fail open")
	}
}
