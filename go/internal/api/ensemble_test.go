// Package api — ensemble_test.go: ElevenLabs primary, Groq secondary, Gemini
// reconciling — as the HTTP pipeline actually runs them.
//
// The unit tests of the cloud package prove each engine alone. These tests
// prove the pipeline wiring: that the job's transcript is the MERGED text, a
// dead primary falls back to Groq, a dead reconciler degrades to the primary,
// and the engine telemetry names what really produced the lines.
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// stubElevenWords serves the Scribe word reply the way the real API does.
func stubElevenWords(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"language_code":"hi","language_probability":0.97,"text":"","words":[
			{"text":"hello","type":"word","start":0,"end":1},
			{"text":"world","type":"word","start":1,"end":2}]}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// stubGeminiText answers generateContent with `text` as the model's message.
func stubGeminiText(t *testing.T, text string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		resp, _ := json.Marshal(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{
					"parts": []any{map[string]any{"text": text}},
				},
			}},
		})
		_, _ = w.Write(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// wireEleven points the server's primary transcriber at an httptest endpoint.
func wireEleven(t *testing.T, s *Server, endpoint string) {
	t.Helper()
	s.deps.Eleven = cloud.NewEleven([]string{"test-key-1"}, "scribe_v1", endpoint, "")
}

// TestEnsembleProducesMergedTranscript is the feature's headline: with all
// three engines configured, the job's transcript is Gemini's reconciliation —
// not either engine's raw reading — and the telemetry says so.
func TestEnsembleProducesMergedTranscript(t *testing.T) {
	elevenSrv := stubElevenWords(t)
	geminiSrv := stubGeminiText(t, `[{"start":0,"end":2,"text":"sabse sahi line"}]`)

	s, _ := newTestServer(t, baseConfig(), stubGroq(t))
	wireEleven(t, s, elevenSrv.URL)
	s.deps.Gemini = cloud.NewGemini("gk", "gemini-2.5-flash", geminiSrv.URL)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q)", got.State, got.Error)
	}
	if got.Engine != "elevenlabs+groq+gemini" {
		t.Errorf("engine = %q, want the full ensemble", got.Engine)
	}
	if len(got.Transcript) != 1 || got.Transcript[0].Text != "sabse sahi line" {
		t.Errorf("transcript = %+v, want Gemini's merged line", got.Transcript)
	}
}

// TestElevenOutageFallsBackToGroq: the primary's pool is empty of answers
// (every attempt 500s) — the chunk must still transcribe, on the secondary.
func TestElevenOutageFallsBackToGroq(t *testing.T) {
	elevenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(elevenSrv.Close)
	geminiSrv := stubGeminiText(t, `[{"start":0,"end":2,"text":"should never be used"}]`)

	s, _ := newTestServer(t, baseConfig(), stubGroq(t))
	wireEleven(t, s, elevenSrv.URL)
	s.deps.Gemini = cloud.NewGemini("gk", "gemini-2.5-flash", geminiSrv.URL)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done on the fallback", got.State, got.Error)
	}
	if got.Engine != "groq (fallback)" {
		t.Errorf("engine = %q, want groq (fallback)", got.Engine)
	}
	if len(got.Transcript) != 1 || got.Transcript[0].Text != "hello" {
		t.Errorf("transcript = %+v, want Groq's hello", got.Transcript)
	}
}

// TestGeminiOutageDegradesToPrimary: the merge is an upgrade, never a
// dependency. With the reconciler down, the primary's own reading ships.
func TestGeminiOutageDegradesToPrimary(t *testing.T) {
	elevenSrv := stubElevenWords(t)
	geminiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(geminiSrv.Close)

	s, _ := newTestServer(t, baseConfig(), stubGroq(t))
	wireEleven(t, s, elevenSrv.URL)
	s.deps.Gemini = cloud.NewGemini("gk", "gemini-2.5-flash", geminiSrv.URL)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q)", got.State, got.Error)
	}
	if got.Engine != "elevenlabs" {
		t.Errorf("engine = %q, want elevenlabs (merge is optional)", got.Engine)
	}
	if len(got.Transcript) != 1 || got.Transcript[0].Text != "hello world" {
		t.Errorf("transcript = %+v, want the primary reading", got.Transcript)
	}
}

// TestFastModeSkipsTheEnsemble: fast mode exists to spend one upload, not
// three — Groq and Gemini must never be contacted.
func TestFastModeSkipsTheEnsemble(t *testing.T) {
	elevenSrv := stubElevenWords(t)
	var geminiCalls, groqCalls int
	var mu sync.Mutex
	geminiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		geminiCalls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(geminiSrv.Close)
	groqSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		groqCalls++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"segments":[]}`))
	}))
	t.Cleanup(groqSrv.Close)

	cfg := baseConfig()
	cfg.TranscribeMode = "fast"
	s, _ := newTestServer(t, cfg, groqSrv)
	wireEleven(t, s, elevenSrv.URL)
	s.deps.Gemini = cloud.NewGemini("gk", "gemini-2.5-flash", geminiSrv.URL)

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q)", got.State, got.Error)
	}
	if got.Engine != "elevenlabs" {
		t.Errorf("engine = %q, want elevenlabs only", got.Engine)
	}
	mu.Lock()
	defer mu.Unlock()
	if groqCalls != 0 || geminiCalls != 0 {
		t.Errorf("fast mode called groq=%d gemini=%d times, want 0/0", groqCalls, geminiCalls)
	}
}

// TestHealthReportsEngineCapabilities: the setup page reads per-engine truth,
// so adding an ElevenLabs pool must light up its own capability — and the
// whole-pipeline "transcribe" flag must come up on the pool alone, because the
// transcribe button no longer depends on Groq.
func TestHealthReportsEngineCapabilities(t *testing.T) {
	cfg := baseConfig()
	cfg.ElevenAPIKeys = []string{"k"}
	s, _ := newTestServer(t, cfg, nil)

	rec := do(t, s, http.MethodGet, "/healthz", "")
	var h model.Health
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if h.Cloud["transcribe"] != "ready" {
		t.Errorf("transcribe = %q, want ready on the ElevenLabs pool alone", h.Cloud["transcribe"])
	}
	if h.Cloud["transcribe_elevenlabs"] != "ready" {
		t.Errorf("transcribe_elevenlabs = %q", h.Cloud["transcribe_elevenlabs"])
	}
	if h.Cloud["ensemble"] == "ready" {
		t.Error("ensemble must not be ready without Groq and Gemini")
	}
}

// ── the pool's HTTP surface ──────────────────────────────────────────────

// newElevenTestServer wires a server whose ElevenLabs client probes against a
// stub: GOODKEY-123 is live, anything else is rejected. The overlay writes to
// a temp .env so no test ever touches the developer's real keys.
func newElevenTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()

	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("xi-api-key") == "GOODKEY-123" {
			_, _ = w.Write([]byte(`{"tier":"free","character_count":100,"character_limit":10000}`))
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(probe.Close)

	s, _ := newTestServer(t, baseConfig(), nil)
	s.deps.EnvPath = filepath.Join(t.TempDir(), ".env")
	s.deps.Eleven = &cloud.ElevenClient{
		Model:  "scribe_v1",
		URL:    "http://unused",
		SubURL: probe.URL,
		HTTP:   probe.Client(),
		// The real daemon's pool persists beside the overlay, which is how a
		// quota snapshot survives the client rebuild a save triggers.
		Pool: cloud.NewKeyPool(config.PoolPath(s.deps.EnvPath), nil),
	}
	return s, probe
}

func TestElevenKeysAddListRemoveRoundtrip(t *testing.T) {
	s, _ := newElevenTestServer(t)

	// A bad key never enters the pool.
	rec := do(t, s, http.MethodPost, "/v1/keys/elevenlabs/add",
		jsonBody(t, map[string]string{"key": "BADKEY-999"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bad key status = %d, want 400", rec.Code)
	}

	// The good key is probed, added and persisted.
	rec = do(t, s, http.MethodPost, "/v1/keys/elevenlabs/add",
		jsonBody(t, map[string]string{"key": "GOODKEY-123"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("add status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var added struct {
		Keys []cloud.KeyStatus `json:"keys"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatalf("decode add: %v", err)
	}
	if len(added.Keys) != 1 || added.Keys[0].ID == "" {
		t.Fatalf("keys = %+v, want one entry with a stable id", added.Keys)
	}
	if added.Keys[0].QuotaLimit != 10000 {
		t.Errorf("quota_limit = %d, want the probe's snapshot carried into the pool", added.Keys[0].QuotaLimit)
	}
	if !strings.Contains(readOverlay(t, s), "ELEVENLABS_API_KEYS=GOODKEY-123") {
		t.Errorf("the overlay never received the key: %s", readOverlay(t, s))
	}

	// Removing by the listed id empties the pool and the overlay.
	rec = do(t, s, http.MethodPost, "/v1/keys/elevenlabs/remove",
		jsonBody(t, map[string]string{"id": added.Keys[0].ID}))
	if rec.Code != http.StatusOK {
		t.Fatalf("remove status = %d, body=%s", rec.Code, rec.Body.String())
	}
	rec = do(t, s, http.MethodGet, "/v1/keys/elevenlabs", "")
	if err := json.Unmarshal(rec.Body.Bytes(), &added); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(added.Keys) != 0 {
		t.Errorf("keys after remove = %+v, want none", added.Keys)
	}
}

// TestElevenEnvImportImportsAllThreeServices: one pasted .env fills the pool
// AND the two single-key cards — that is the whole point of the import
// button. A rejected key is reported per key, never fails the batch.
func TestElevenEnvImportImportsAllThreeServices(t *testing.T) {
	s, _ := newElevenTestServer(t)

	env := "GROQ_API_KEY=groq-test-key\n" +
		"GEMINI_API_KEY=gemini-test-key\n" +
		"ELEVENLABS_API_KEYS=GOODKEY-123, BADKEY-999\n" +
		"# a comment, and unrelated vars that must be ignored\n" +
		"SOMETHING_ELSE=no\n"

	rec := do(t, s, http.MethodPost, "/v1/keys/elevenlabs/import",
		jsonBody(t, map[string]string{"content": env}))
	if rec.Code != http.StatusOK {
		t.Fatalf("import status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var res struct {
		Added    []string `json:"added"`
		Rejected []string `json:"rejected"`
		Groq     bool     `json:"groq_updated"`
		Gemini   bool     `json:"gemini_updated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(res.Added) != 1 || !strings.HasPrefix(res.Added[0], "GOOD") {
		t.Errorf("added = %v, want exactly the good key (masked)", res.Added)
	}
	if len(res.Rejected) != 1 || !strings.HasPrefix(res.Rejected[0], "BADK") {
		t.Errorf("rejected = %v, want exactly the dead key (masked)", res.Rejected)
	}
	if !res.Groq || !res.Gemini {
		t.Errorf("groq/gemini picked up = %v/%v, want both", res.Groq, res.Gemini)
	}

	overlay := readOverlay(t, s)
	for _, want := range []string{
		"ELEVENLABS_API_KEYS=GOODKEY-123",
		"GROQ_API_KEY=groq-test-key",
		"GEMINI_API_KEY=gemini-test-key",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay missing %q:\n%s", want, overlay)
		}
	}
}

func readOverlay(t *testing.T, s *Server) string {
	t.Helper()
	raw, err := os.ReadFile(config.KeysPath(s.deps.EnvPath))
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	return string(raw)
}
