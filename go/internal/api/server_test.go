package api

import (
	"context"
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

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// newTestServer builds a server with a real queue.
//
// groqSrv, when non-nil, is wired as a live Groq endpoint so transcribe jobs
// actually run. Leaving it nil keeps deps.Groq nil, which is how the
// "provider not configured" path is exercised.
func newTestServer(t *testing.T, cfg *config.Config, groqSrv *httptest.Server) (*Server, *queue.Queue) {
	t.Helper()

	q := queue.New(queue.Options{
		Workers:     1,
		Capacity:    cfg.QueueCapacity,
		MaxAttempts: 1,
		BaseBackoff: time.Millisecond,
	})
	t.Cleanup(q.Close)

	deps := Deps{
		Config: cfg,
		Queue:  q,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Vault:  vault.Unconfigured(),
	}
	if groqSrv != nil {
		deps.Groq = cloud.NewGroq("test-key", "whisper-large-v3", groqSrv.URL)
	}

	return New(deps), q
}

// stubGroq serves a minimal valid transcription response.
func stubGroq(t *testing.T) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"segments":[{"id":0,"start":0,"end":2,"text":"hello"}]}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func baseConfig() *config.Config {
	return &config.Config{
		Addr:           "127.0.0.1:0",
		Workers:        1,
		QueueCapacity:  8,
		MaxAttempts:    1,
		GroqTranscribe: "whisper-large-v3",
		GeminiModel:    "gemini-2.5-flash",
		GroqMaxChunkMB: 15,
		SessionDir:     os.TempDir(),
		TelegramAPIID:  0,
		BaseBackoff:    time.Millisecond,
	}
}

func do(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()

	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rdr)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// jsonBody marshals a payload.
//
// Bodies are never built by string concatenation: Windows paths contain
// backslashes and "C:\Users\..." is not valid JSON. The production client is
// Rust's serde, which escapes correctly; these tests have to do the same.
func jsonBody(t *testing.T, v any) string {
	t.Helper()

	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return string(b)
}

func transcribeBody(t *testing.T, paths ...string) string {
	t.Helper()

	chunks := make([]model.ChunkRequest, 0, len(paths))
	for i, p := range paths {
		chunks = append(chunks, model.ChunkRequest{
			Path: p, OffsetSecs: float64(i) * 900, Index: i,
		})
	}
	return jsonBody(t, model.TranscribeRequest{
		SourcePath: "D:/videos/lecture.mp4",
		Chunks:     chunks,
	})
}

func writeChunk(t *testing.T) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "c0.m4a")
	if err := os.WriteFile(path, []byte("fake audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// ── Health ──────────────────────────────────────────────────────────────

func TestHealthReportsCapabilities(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var h model.Health
	if err := json.Unmarshal(rec.Body.Bytes(), &h); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if !h.OK {
		t.Error("health should report OK")
	}
	if h.Cloud["transcribe"] == "ready" {
		t.Error("transcribe must not be ready without a Groq key")
	}
	if h.Queue.Capacity != 8 || h.Queue.Workers != 1 {
		t.Errorf("queue stats wrong: %+v", h.Queue)
	}
}

// ── Provider gating ─────────────────────────────────────────────────────

func TestTranscribeRefusedWithoutGroqClient(t *testing.T) {
	cfg := baseConfig()
	cfg.GroqAPIKey = "k" // config claims ready…
	s, _ := newTestServer(t, cfg, nil)

	// …but no client is wired. The handler must trust the dependency it will
	// actually dereference, not the config flag, or the worker panics.
	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestAnalyzeRefusedWithoutGeminiClient(t *testing.T) {
	cfg := baseConfig()
	cfg.GeminiAPIKey = "k"
	s, _ := newTestServer(t, cfg, nil)

	rec := do(t, s, http.MethodPost, "/v1/analyze",
		jsonBody(t, model.AnalyzeRequest{Segments: []model.Segment{{ID: "1"}}}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// ── Request validation ──────────────────────────────────────────────────

func TestTranscribeRejectsEmptyChunkList(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	rec := do(t, s, http.MethodPost, "/v1/transcribe",
		jsonBody(t, model.TranscribeRequest{SourcePath: "x.mp4"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestTranscribeRejectsChunkThatIsNotOnDisk(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	// The Rust side writes the chunks. A wrong path must fail here,
	// immediately, rather than halfway through a long transcription.
	rec := do(t, s, http.MethodPost, "/v1/transcribe",
		transcribeBody(t, filepath.Join(t.TempDir(), "absent.m4a")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "chunk not readable") {
		t.Errorf("unexpected body %q", rec.Body.String())
	}
}

func TestMalformedJSONIsRejected(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	rec := do(t, s, http.MethodPost, "/v1/transcribe", `{"chunks": [}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

// ── Happy path ──────────────────────────────────────────────────────────

func TestTranscribeAcceptsRealChunks(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}

	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if job.ID == "" || job.Kind != model.JobTranscribe {
		t.Errorf("bad job: %+v", job)
	}
	if job.Total != 1 {
		t.Errorf("Total = %d, want 1", job.Total)
	}
}

func TestTranscribeProducesTranscript(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))

	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Wait for the worker, then confirm the transcript came back with
	// absolute timestamps rather than chunk-local ones.
	deadline := time.Now().Add(3 * time.Second)
	var got model.Job
	for time.Now().Before(deadline) {
		r := do(t, s, http.MethodGet, "/v1/jobs/"+job.ID, "")
		if r.Code != http.StatusOK {
			t.Fatalf("job fetch status = %d", r.Code)
		}
		if err := json.Unmarshal(r.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.State.Terminal() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if len(got.Transcript) != 1 {
		t.Fatalf("got %d segments, want 1", len(got.Transcript))
	}
	if got.Transcript[0].Text != "hello" {
		t.Errorf("text = %q", got.Transcript[0].Text)
	}
	if !got.Transcript[0].Keep {
		t.Error("segments must default to keep")
	}
}

// ── Backpressure ────────────────────────────────────────────────────────

func TestFullQueueReturns429WithRetryAfter(t *testing.T) {
	cfg := baseConfig()
	cfg.QueueCapacity = 1
	chunk := writeChunk(t)

	s, q := newTestServer(t, cfg, stubGroq(t))

	// Occupy the single worker with something that never returns on its own.
	block := make(chan struct{})
	if err := q.Submit(context.Background(), queue.Task{
		ID:  "blocker",
		Run: func(_ context.Context) error { <-block; return nil },
	}); err != nil {
		t.Fatalf("occupy worker: %v", err)
	}
	t.Cleanup(func() { close(block) })

	body := transcribeBody(t, chunk)

	var lastCode int
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		rec := do(t, s, http.MethodPost, "/v1/transcribe", body)
		lastCode = rec.Code
		if rec.Code == http.StatusTooManyRequests {
			if rec.Header().Get("Retry-After") == "" {
				t.Error("429 should carry Retry-After so the client knows how long to wait")
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	if lastCode != http.StatusTooManyRequests {
		t.Fatalf("last status = %d, want 429 once the queue filled", lastCode)
	}
}

// ── Job lookup ──────────────────────────────────────────────────────────

func TestJobEndpointReportsUnknownID(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodGet, "/v1/jobs/does-not-exist", "")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestJobEndpointReturnsSubmittedJob(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubGroq(t))

	rec := do(t, s, http.MethodPost, "/v1/transcribe", transcribeBody(t, writeChunk(t)))

	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if rec2 := do(t, s, http.MethodGet, "/v1/jobs/"+job.ID, ""); rec2.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec2.Code)
	}
}

// ── Vault ───────────────────────────────────────────────────────────────

func TestVaultUploadAcceptedWithoutUploader(t *testing.T) {
	f := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(f, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestServer(t, baseConfig(), nil)

	// Accepted as a job, then fails cleanly in the worker — the MTProto
	// transport is Chunk 5.
	rec := do(t, s, http.MethodPost, "/v1/vault/upload",
		jsonBody(t, map[string]string{"path": f}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
}

func TestVaultAuthoriseRefusedWithoutUploader(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodPost, "/v1/vault/authorise", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// ── Robustness ──────────────────────────────────────────────────────────

func TestHandlerPanicDoesNotKillTheServer(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	// Drive the mux directly with a writer that panics mid-write, so the
	// recovery layer is the only thing standing between this and a dead server.
	func() {
		defer func() { _ = recover() }()
		req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		s.mux.ServeHTTP(&panicWriter{ResponseWriter: httptest.NewRecorder()}, req)
	}()

	if rec := do(t, s, http.MethodGet, "/healthz", ""); rec.Code != http.StatusOK {
		t.Fatalf("server stopped answering after a panic: %d", rec.Code)
	}
}

type panicWriter struct{ http.ResponseWriter }

func (p *panicWriter) Write([]byte) (int, error) { panic("boom") }
