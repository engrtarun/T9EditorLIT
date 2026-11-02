package api

// Key CRUD tests. The whole contract of api/keys.go is here:
//
//   - a full key never comes back out of the daemon, in any response,
//   - saving writes the overlay beside .env and hot-swaps the live client,
//   - removing is real: an explicit empty override, so a key in .env or in
//     the process environment cannot resurrect it,
//   - an unknown service is a 400, not a file with a typo in it.

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/config"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// newKeyServer builds a daemon whose .env lives in a temp directory, so the
// overlay file the handlers write is throwaway and never touches the real one.
func newKeyServer(t *testing.T) (*Server, string) {
	t.Helper()

	dir := t.TempDir()
	envPath := filepath.Join(dir, ".env")
	if err := os.WriteFile(envPath, []byte("# the user's own file\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}

	cfg, err := config.Load(envPath)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}

	q := queue.New(queue.Options{
		Workers:     1,
		Capacity:    4,
		MaxAttempts: 1,
		BaseBackoff: time.Millisecond,
	})
	t.Cleanup(q.Close)

	srv := New(Deps{
		Config:  cfg,
		Queue:   q,
		Log:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Vault:   vault.Unconfigured(),
		EnvPath: envPath,
	})
	return srv, envPath
}

func keyDo(t *testing.T, srv *Server, method, path, body string) (*httptest.ResponseRecorder, string) {
	t.Helper()

	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, r)
	return w, w.Body.String()
}

func TestKeysListMasksEveryCredential(t *testing.T) {
	srv, _ := newKeyServer(t)
	// Real clients so the list has something to mask (no calls are made).
	srv.deps.Config.GroqAPIKey = "gsk_live_abcdefghijklmnop"
	srv.deps.Config.GeminiAPIKey = "AQ.short"
	srv.deps.Groq = nil

	w, body := keyDo(t, srv, http.MethodGet, "/v1/keys", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, body)
	}

	var out struct {
		Keys []keyState `json:"keys"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v (body %s)", err, body)
	}
	if len(out.Keys) != 2 {
		t.Fatalf("keys = %d, want groq and gemini", len(out.Keys))
	}

	for _, k := range out.Keys {
		if !k.Configured {
			t.Errorf("%s should be configured", k.Service)
		}
		if k.Masked == "" {
			t.Errorf("%s has no mask", k.Service)
		}
	}
	if strings.Contains(body, "gsk_live_abcdefghijklmnop") {
		t.Error("the full Groq key was returned to the UI")
	}
	if strings.Contains(body, "AQ.short") {
		t.Error("a short key was returned in full; short keys must be fully hidden")
	}
}

func TestSaveKeyWritesOverlayAndSwapsClient(t *testing.T) {
	srv, envPath := newKeyServer(t)

	w, body := keyDo(t, srv, http.MethodPut, "/v1/keys/groq", `{"key":"gsk_test_key_1234567890"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, body)
	}
	if strings.Contains(body, "gsk_test_key_1234567890") {
		t.Fatalf("save echoed the full key back: %s", body)
	}

	// The hot swap really happened: the client exists and healthz agrees.
	if srv.groqClient() == nil {
		t.Error("saving a key must build the Groq client immediately")
	}
	_, health := keyDo(t, srv, http.MethodGet, "/healthz", "")
	if !strings.Contains(health, "ready") {
		t.Errorf("healthz did not flip to ready: %s", health)
	}

	// The key landed in keys.local.env, not in the user's .env.
	overlay, err := os.ReadFile(config.KeysPath(envPath))
	if err != nil {
		t.Fatalf("overlay was not written: %v", err)
	}
	if !strings.Contains(string(overlay), "GROQ_API_KEY=gsk_test_key_1234567890") {
		t.Errorf("overlay = %q", overlay)
	}
	envData, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	if strings.Contains(string(envData), "gsk_test_key") {
		t.Error("the user's .env must never be written by the app")
	}

	// A reload sees the same key: the save survives a daemon restart.
	cfg, err := config.Load(envPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if cfg.GroqAPIKey != "gsk_test_key_1234567890" {
		t.Errorf("reloaded GroqAPIKey = %q", cfg.GroqAPIKey)
	}
}

func TestDeleteKeyIsRealAndStaysDeleted(t *testing.T) {
	srv, envPath := newKeyServer(t)

	// Put a key in .env first: deletion must beat the file it came from.
	if err := os.WriteFile(envPath, []byte("GEMINI_API_KEY=from_dot_env\n"), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	cfg, err := config.Load(envPath)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	srv.deps.Config = cfg
	srv.applyKey("gemini", cfg.GeminiAPIKey)

	w, body := keyDo(t, srv, http.MethodDelete, "/v1/keys/gemini", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", w.Code, body)
	}
	if !strings.Contains(body, `"configured":false`) {
		t.Errorf("delete said the key is still configured: %s", body)
	}
	if srv.geminiClient() != nil {
		t.Error("removing a key must drop the live client")
	}

	// The explicit empty override is what stops .env from resurrecting it.
	reloaded, err := config.Load(envPath)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if reloaded.GeminiAPIKey != "" {
		t.Errorf("GeminiAPIKey = %q after delete; a removed key must stay removed", reloaded.GeminiAPIKey)
	}
}

func TestKeyRoutesRejectJunk(t *testing.T) {
	srv, _ := newKeyServer(t)

	cases := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"unknown service on save", http.MethodPut, "/v1/keys/openai", `{"key":"sk-1"}`},
		{"unknown service on delete", http.MethodDelete, "/v1/keys/telegram", ""},
		{"empty key", http.MethodPut, "/v1/keys/groq", `{"key":"   "}`},
		{"missing body", http.MethodPut, "/v1/keys/groq", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, body := keyDo(t, srv, tc.method, tc.path, tc.body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (%s)", w.Code, body)
			}
		})
	}

	// Nothing junk-shaped may have reached the overlay.
	if _, err := os.Stat(config.KeysPath(srv.deps.EnvPath)); err == nil {
		t.Error("a rejected request wrote an overlay file")
	}
}

func TestUsageEndpointIsQuietWhenNothingRan(t *testing.T) {
	srv, _ := newKeyServer(t)

	w, body := keyDo(t, srv, http.MethodGet, "/v1/usage", "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 even with no calls: %s", w.Code, body)
	}

	var out struct {
		Services map[string]any `json:"services"`
		Recent   []any          `json:"recent"`
		Keys     []keyState     `json:"keys"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("decode: %v (body %s)", err, body)
	}
	if out.Services == nil {
		t.Error("services must be an object, not null")
	}
	if out.Recent == nil {
		t.Error("recent must be an array, not null — the UI iterates it")
	}
	if len(out.Keys) != 2 {
		t.Errorf("keys = %d, want 2", len(out.Keys))
	}

	// Gemini publishes no quota headers, so a fresh daemon must say
	// "unknown" (-1) rather than a confident 0%.
	if strings.Contains(body, `"requests_used_pct":0`) {
		t.Error("an unmeasured provider reported 0% instead of -1")
	}
}
