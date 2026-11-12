package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// Case 16 and 17: a music bed. The file carries sound and no words.
//
// The job has to end as "music", not as a failure and not as an empty
// transcript the user is invited to retry - and it must stop paying for the
// rest of the file.
func TestAMusicFileStopsAfterTwoChunksAndIsMarkedAsMusic(t *testing.T) {
	var mu sync.Mutex
	calls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		// The model returns a line it does not believe: high no_speech_prob
		// and a poor logprob. That is what a music bed looks like from the
		// provider's side.
		_, _ = w.Write([]byte(`{"language":"english","segments":[` +
			`{"id":0,"start":0,"end":2,"text":"[Music]","no_speech_prob":0.95,"avg_logprob":-2.0},` +
			`{"id":1,"start":2,"end":4,"text":"[Music]","no_speech_prob":0.9,"avg_logprob":-1.5}]}`))
	}))
	t.Cleanup(srv.Close)

	// Real audio: a loud tone, so the file measures as "mostly sound".
	chunk := writeProfileChunk(t, 10, -6, -6, 0, 10)

	s, _ := newTestServer(t, baseConfig(), srv)
	rec := do(t, s, http.MethodPost, "/v1/transcribe",
		transcribeBody(t, chunk, chunk, chunk, chunk, chunk))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	done := waitForJob(t, s, job.ID)
	if done.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", done.State, done.Error)
	}
	if !done.Music {
		t.Error("a file with sound and no words must be marked as music")
	}
	if !done.NoSpeech {
		t.Error("a music file has no speech either")
	}
	if len(done.Transcript) != 0 {
		t.Errorf("transcript = %d lines, want none", len(done.Transcript))
	}

	mu.Lock()
	defer mu.Unlock()
	if calls >= 5 {
		t.Errorf("the job made %d upstream calls, want it to stop after the music probe", calls)
	}
	if calls == 0 {
		t.Error("the job made no upstream calls at all")
	}
}

// The opposite case: a file that is mostly quiet and opens with silence is
// not a music bed. The probe must not fire on it.
func TestAQuietFileIsNotCalledMusic(t *testing.T) {
	var mu sync.Mutex
	calls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"language":"english","segments":[` +
			`{"id":0,"start":0,"end":2,"text":"[Music]","no_speech_prob":0.95,"avg_logprob":-2.0}]}`))
	}))
	t.Cleanup(srv.Close)

	// 10 s of sound, then 10 s of digital silence: the file is half quiet.
	sound := writeProfileChunk(t, 10, -6, -6, 0, 10)
	silent := writeProfileChunk(t, 10, -90, -90, 0, 10)

	s, _ := newTestServer(t, baseConfig(), srv)
	rec := do(t, s, http.MethodPost, "/v1/transcribe",
		transcribeBody(t, sound, silent))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	done := waitForJob(t, s, job.ID)
	if done.Music {
		t.Error("a file that is half quiet must not be called a music bed")
	}

	mu.Lock()
	defer mu.Unlock()
	// Only the loud chunk was uploaded: the quiet one never left the machine,
	// which is the local gate doing its job.
	if calls != 1 {
		t.Errorf("the job made %d upstream calls, want 1 (the quiet chunk is skipped locally)", calls)
	}
}

// Case 11: every line carries the language the model decoded it as, so the
// UI can show a badge on a line whose language changed.
func TestEveryLineCarriesItsLanguage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"language":"hindi","segments":[` +
			`{"id":0,"start":0,"end":2,"text":"pehla vakya"}]}`))
	}))
	t.Cleanup(srv.Close)

	chunk := writeProfileChunk(t, 5, -20, -8, 1, 4)

	s, _ := newTestServer(t, baseConfig(), srv)
	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, chunk))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	done := waitForJob(t, s, job.ID)
	if done.State != model.StateDone {
		t.Fatalf("state = %q (error %q)", done.State, done.Error)
	}
	if len(done.Transcript) != 1 {
		t.Fatalf("transcript = %d lines, want 1", len(done.Transcript))
	}
	if got := done.Transcript[0].Language; got != "hi" {
		t.Errorf("line language = %q, want \"hi\"", got)
	}
}

// The job reports the profile it measured, so the app does not have to ask
// for it a second time.
func TestTheJobCarriesTheAudioProfile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"language":"hindi","segments":[` +
			`{"id":0,"start":0,"end":2,"text":"pehla vakya"}]}`))
	}))
	t.Cleanup(srv.Close)

	chunk := writeProfileChunk(t, 10, -28, -6, 3, 8)

	s, _ := newTestServer(t, baseConfig(), srv)
	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, chunk))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	done := waitForJob(t, s, job.ID)
	if done.AudioProfile == nil {
		t.Fatal("the job must carry the audio profile it measured")
	}
	if done.AudioProfile.NoiseFloorDB == 0 || done.AudioProfile.SNRDB == 0 {
		t.Errorf("the profile is empty: %+v", done.AudioProfile)
	}
	if done.AudioProfile.SilenceThresholdDB == 0 {
		t.Error("the profile must carry the threshold the cut map should use")
	}
}
