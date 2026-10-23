package api

// Key probe tests. The endpoint's whole story is one round trip: the key in
// the body, the verdict out, never the key in a log. These tests exercise the
// real clients end to end against httptest stubs, so both halves
// (api/keys_probe.go and cloud/probe.go) are under test at once.

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// newProbeServer builds a server with the given provider clients. Passing nil
// keeps a provider unconfigured, which is how the "no key on this daemon"
// answer is exercised.
func newProbeServer(t *testing.T, groq *cloud.GroqClient, gemini *cloud.GeminiClient) *Server {
	t.Helper()

	q := queue.New(queue.Options{
		Workers:     1,
		Capacity:    4,
		MaxAttempts: 1,
		BaseBackoff: time.Millisecond,
	})
	t.Cleanup(q.Close)

	return New(Deps{
		Config: baseConfig(),
		Queue:  q,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Vault:  vault.Unconfigured(),
		Groq:   groq,
		Gemini: gemini,
	})
}

// probeResult decodes the endpoint's outcome payload.
func probeResult(t *testing.T, rec *httptest.ResponseRecorder) cloud.ProbeResult {
	t.Helper()

	var res cloud.ProbeResult
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode probe result: %v\nbody: %s", err, rec.Body.String())
	}
	return res
}

// groqModelsStub stands in for Groq's models list, recording the Bearer key
// that actually arrived. status and payload drive the verdict branch.
func groqModelsStub(t *testing.T, status int, payload string, seenKey *atomic.Value) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/models") {
			http.NotFound(w, r)
			return
		}
		if seenKey != nil {
			seenKey.Store(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// ── Groq probe ──────────────────────────────────────────────────────────

func TestKeysProbeGroqLive(t *testing.T) {
	var seen atomic.Value
	srv := groqModelsStub(t, http.StatusOK,
		`{"data":[{"id":"llama-3.3-70b"},{"id":"whisper-large-v3"}]}`, &seen)

	client := cloud.NewGroq("k-configured", "whisper-large-v3", "", srv.URL)
	s := newProbeServer(t, client, nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"groq","key":"k-body"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (probe verdicts are data, not errors): %s",
			rec.Code, rec.Body.String())
	}

	res := probeResult(t, rec)
	if !res.OK {
		t.Fatalf("probe should pass, got ok=%v detail=%q", res.OK, res.Detail)
	}
	if got := strings.Contains(res.Detail, "2 models visible"); !got {
		t.Errorf("detail should report the model tally, got %q", res.Detail)
	}
	if key := seen.Load().(string); key != "k-body" {
		t.Errorf("probe must test the body key, stub saw %q", key)
	}
}

func TestKeysProbeEmptyKeyUsesConfigured(t *testing.T) {
	var seen atomic.Value
	srv := groqModelsStub(t, http.StatusOK, `{"data":[]}`, &seen)

	s := newProbeServer(t, cloud.NewGroq("k-env", "whisper-large-v3", "", srv.URL), nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"groq","key":""}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	res := probeResult(t, rec)
	if !res.OK {
		t.Fatalf("an empty-list answer still proves the key: %q", res.Detail)
	}
	if res.Detail != "key works — account answered" {
		t.Errorf("zero models is still a proven key, got %q", res.Detail)
	}
	if key := seen.Load().(string); key != "k-env" {
		t.Errorf("empty body key must fall back to the configured key, stub saw %q", key)
	}
}

func TestKeysProbeGroqServerErrorIsNotAKeyProblem(t *testing.T) {
	srv := groqModelsStub(t, http.StatusInternalServerError, `{"error":"boom"}`, nil)
	s := newProbeServer(t, cloud.NewGroq("k-env", "whisper-large-v3", "", srv.URL), nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"groq"}`)
	res := probeResult(t, rec)
	if res.OK {
		t.Fatal("a 500 must not read as a working key")
	}
	if !strings.Contains(res.Detail, "500") || !strings.Contains(res.Detail, "not a key problem") {
		t.Errorf("detail should separate provider trouble from key trouble, got %q", res.Detail)
	}
}

func TestKeysProbeGroqRateLimited(t *testing.T) {
	srv := groqModelsStub(t, http.StatusTooManyRequests, `{}`, nil)
	s := newProbeServer(t, cloud.NewGroq("k-env", "whisper-large-v3", "", srv.URL), nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"groq"}`)
	res := probeResult(t, rec)
	if res.OK || !strings.Contains(res.Detail, "429") {
		t.Errorf("want ok=false with the 429 in the sentence, got %q", res.Detail)
	}
}

func TestKeysProbeEchoIsTruncated(t *testing.T) {
	body := strings.Repeat("x", 180)
	srv := groqModelsStub(t, http.StatusBadRequest, body, nil)
	s := newProbeServer(t, cloud.NewGroq("k-env", "whisper-large-v3", "", srv.URL), nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"groq"}`)
	res := probeResult(t, rec)
	if !strings.Contains(res.Detail, "400") || !strings.HasSuffix(res.Detail, "…") {
		t.Fatalf("detail should carry the story and the cut marker, got %q", res.Detail)
	}
	if n := strings.Count(res.Detail, "x"); n != 160 {
		t.Errorf("echo should be cut at 160 characters, got %d", n)
	}
}

// ── Gemini probe ────────────────────────────────────────────────────────

func TestKeysProbeGeminiRejectedKey(t *testing.T) {
	var seen atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.URL.Query().Get("key"))
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"API key invalid"}`))
	}))
	t.Cleanup(srv.Close)

	s := newProbeServer(t, nil, cloud.NewGemini("k-env", "gemini-2.5-flash", srv.URL))

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"gemini","key":"k-body-bad"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	res := probeResult(t, rec)
	if res.OK || !strings.Contains(res.Detail, "401") {
		t.Errorf("want ok=false naming the rejection, got %q", res.Detail)
	}
	if key := seen.Load().(string); key != "k-body-bad" {
		t.Errorf("the body key should travel in the query, stub saw %q", key)
	}
}

func TestKeysProbeGeminiEmptyKeyFallsBack(t *testing.T) {
	var seen atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.URL.Query().Get("key"))
		_, _ = w.Write([]byte(`{"data":[{"id":"gemini-2.5-flash"},{"id":"gemini-2.5-pro"},
{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}`))
	}))
	t.Cleanup(srv.Close)

	s := newProbeServer(t, nil, cloud.NewGemini("k-env", "gemini-2.5-flash", srv.URL))

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"gemini"}`)
	res := probeResult(t, rec)
	if !res.OK || !strings.Contains(res.Detail, "6+ models visible") {
		t.Errorf("want ok=true with the at-least tally, got %q", res.Detail)
	}
	if key := seen.Load().(string); key != "k-env" {
		t.Errorf("empty body key must fall back to the configured key, stub saw %q", key)
	}
}

// ── Request shape ───────────────────────────────────────────────────────

func TestKeysProbeWithoutClients(t *testing.T) {
	s := newProbeServer(t, nil, nil)

	for _, service := range []string{"groq", "gemini"} {
		rec := do(t, s, http.MethodPost, "/v1/keys/probe",
			`{"service":"`+service+`","key":"k"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", service, rec.Code)
		}
		res := probeResult(t, rec)
		if res.OK {
			t.Errorf("%s: verdict must fail without a client", service)
		}
		if !strings.Contains(strings.ToLower(res.Detail), "no "+service+" key is configured") {
			t.Errorf("%s: detail should name the missing configuration, got %q", service, res.Detail)
		}
	}
}

func TestKeysProbeUnknownService(t *testing.T) {
	s := newProbeServer(t, nil, nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"service":"openai","key":"k"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	var errRes struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errRes); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if !strings.Contains(errRes.Error, "unknown service") {
		t.Errorf("error should name the problem, got %q", errRes.Error)
	}
}

func TestKeysProbeMissingService(t *testing.T) {
	s := newProbeServer(t, nil, nil)

	rec := do(t, s, http.MethodPost, "/v1/keys/probe", `{"key":"k"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	var errRes struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &errRes); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if !strings.Contains(errRes.Error, "service is required") {
		t.Errorf("error should say what is missing, got %q", errRes.Error)
	}
}

func TestKeysProbeRejectsGet(t *testing.T) {
	s := newProbeServer(t, nil, nil)

	if rec := do(t, s, http.MethodGet, "/v1/keys/probe", ""); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405 for GET on a POST-only route", rec.Code)
	}
}

// The setup page will show whatever the daemon answers, so one probe must
// never contain the key under test — the verdict sentence is the only text.
func TestKeysProbeNeverEchoesTheKey(t *testing.T) {
	srv := groqModelsStub(t, http.StatusOK, `{"data":[{"id":"m"}]}`, nil)
	s := newProbeServer(t, cloud.NewGroq("k-env", "whisper-large-v3", "", srv.URL), nil)

	secret := "gsk_secret_9f8a7b6c"
	rec := do(t, s, http.MethodPost, "/v1/keys/probe",
		jsonBody(t, keysProbeRequest{Service: "groq", Key: secret}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Error("the response must never echo the key")
	}
}
