package api

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// The bug these tests exist for: importing a ~1.16 s meme with no speech
// ("Duck Meme Hd Template.mp4") uploaded the chunk to Groq Whisper, raised the
// bill, and stored a fabricated transcript line reading "What?" over a duck
// quack. The device can see there is no speech here — so the call must never
// happen, and a word placed over silence must never be shown.

// writeWAVChunk writes a mono 16-bit PCM WAV at 16 kHz — byte-for-byte the
// shape the Rust side hands the daemon as chunk_000.wav.
func writeWAVChunk(t *testing.T, samples []int16) string {
	t.Helper()

	const rate = 16000
	dataSize := len(samples) * 2
	buf := make([]byte, 44+dataSize)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:], uint32(36+dataSize))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:], 16)
	binary.LittleEndian.PutUint16(buf[20:], 1) // PCM
	binary.LittleEndian.PutUint16(buf[22:], 1) // mono
	binary.LittleEndian.PutUint32(buf[24:], rate)
	binary.LittleEndian.PutUint32(buf[28:], rate*2)
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

// quackMemeChunk mirrors the offending file: 1.161 s long, digital silence
// except one 190 ms quack between 0.75 s and 0.94 s.
func quackMemeChunk(t *testing.T) string {
	t.Helper()

	samples := make([]int16, 18576)
	for i := 12000; i < 15000; i++ {
		samples[i] = 8000
	}
	return writeWAVChunk(t, samples)
}

// countingGroq answers like Whisper but records every upload it receives, so
// "the API was never called" is provable rather than assumed.
func countingGroq(t *testing.T, reply string, calls *atomic.Int32) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// The duck meme itself: a silent clip must finish as "no speech" with zero
// API calls, instead of buying a Whisper transcription of a quack.
func TestSilentClipNeverReachesTheAPI(t *testing.T) {
	var calls atomic.Int32
	srv := countingGroq(t,
		`{"segments":[{"id":0,"start":0,"end":0.9,"text":"What?"}]}`, &calls)

	s, _ := newTestServer(t, baseConfig(), srv)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, quackMemeChunk(t)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if !got.NoSpeech {
		t.Error("NoSpeech = false — a silent clip must report no speech, not a transcript")
	}
	if len(got.Transcript) != 0 {
		t.Errorf("got %d transcript lines, want 0: %q",
			len(got.Transcript), got.Transcript[0].Text)
	}
	if n := calls.Load(); n != 0 {
		t.Errorf("Groq called %d times for a silent clip — that is the bug", n)
	}
}

// Whisper does get called when there is real sound — but a word it places
// across seconds of silence is dropped, because no audio backs it.
func TestWhisperWordOverSilenceIsDropped(t *testing.T) {
	var calls atomic.Int32
	srv := countingGroq(t,
		`{"segments":[{"id":0,"start":0,"end":4,"text":"What?"}]}`, &calls)

	s, _ := newTestServer(t, baseConfig(), srv)

	// 4 s of audio with sound only in the first 0.9 s: worth uploading
	// (0.9 s of sound), but a word spanning all 4 s cannot be backed by it.
	samples := make([]int16, 4*16000)
	for i := 0; i < 14400; i++ {
		samples[i] = 8000
	}

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeWAVChunk(t, samples)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if !got.NoSpeech {
		t.Error("NoSpeech = false — the only word claimed no audio behind it")
	}
	if len(got.Transcript) != 0 {
		t.Errorf("got %d transcript lines, want 0: %q",
			len(got.Transcript), got.Transcript[0].Text)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("Groq called %d times, want 1 (the chunk had real sound)", n)
	}
}

// The gate must not eat real words: sound under a word keeps it.
func TestWordOverRealAudioSurvivesTheGate(t *testing.T) {
	var calls atomic.Int32
	srv := countingGroq(t,
		`{"segments":[{"id":0,"start":0,"end":2,"text":"hello"}]}`, &calls)

	s, _ := newTestServer(t, baseConfig(), srv)

	samples := make([]int16, 2*16000)
	for i := range samples {
		samples[i] = 5000
	}

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeWAVChunk(t, samples)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if got.NoSpeech {
		t.Error("NoSpeech = true for a clip full of sound — the gate is too aggressive")
	}
	if len(got.Transcript) != 1 || got.Transcript[0].Text != "hello" {
		t.Errorf("transcript = %+v, want the single real line", got.Transcript)
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("Groq called %d times, want 1", n)
	}
}

// Fail open: a chunk the scanner cannot read (the daemon receives .m4a from
// the Rust side, and any scanner error must not eat a transcript) still goes
// to the provider unchanged.
func TestUnscannableChunkStillGoesToTheProvider(t *testing.T) {
	var calls atomic.Int32
	srv := countingGroq(t,
		`{"segments":[{"id":0,"start":0,"end":2,"text":"hello"}]}`, &calls)

	s, _ := newTestServer(t, baseConfig(), srv)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if len(got.Transcript) != 1 {
		t.Errorf("got %d transcript lines, want the scan to fail open", len(got.Transcript))
	}
	if n := calls.Load(); n != 1 {
		t.Errorf("Groq called %d times, want 1", n)
	}
}
