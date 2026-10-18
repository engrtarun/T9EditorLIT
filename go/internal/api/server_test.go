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
	"sync"
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
		deps.Groq = cloud.NewGroq("test-key", "whisper-large-v3", "test-chat", groqSrv.URL)
		// Point the autocorrect endpoint at the same stub so one server can
		// stand in for both of Groq's APIs. The path is kept distinct
		// because the stub tells the two APIs apart by it.
		deps.Groq.ChatURL = groqSrv.URL + "/chat/completions"
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
		GroqChat:       "test-chat",
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

// ── Autocorrect ─────────────────────────────────────────────────────────

// stubChatGroq answers both the transcribe and the chat endpoint, which is all
// the autocorrect job needs.
func stubChatGroq(t *testing.T, reply string) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "chat") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"choices": []map[string]any{{
					"message": map[string]string{"content": reply},
				}},
			})
			return
		}
		_, _ = w.Write([]byte(`{"segments":[{"id":0,"start":0,"end":2,"text":"hello"}]}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestCorrectRefusedWithoutGroqClient(t *testing.T) {
	cfg := baseConfig()
	cfg.GroqAPIKey = "k"
	s, _ := newTestServer(t, cfg, nil)

	rec := do(t, s, http.MethodPost, "/v1/correct",
		jsonBody(t, model.CorrectRequest{Segments: []model.Segment{{ID: "1", Text: "hi"}}}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestCorrectRejectsEmptySegmentList(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), stubChatGroq(t, "[]"))

	rec := do(t, s, http.MethodPost, "/v1/correct", jsonBody(t, model.CorrectRequest{SourcePath: "x.mp4"}))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestCorrectProducesSpellingFixes(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(),
		stubChatGroq(t, `[{"i":0,"text":"JavaScript ek language hai."}]`))

	rec := do(t, s, http.MethodPost, "/v1/correct", jsonBody(t, model.CorrectRequest{
		SourcePath: "x.mp4",
		Segments:   []model.Segment{{ID: "1", Text: "javas cript ek language hai", Keep: true}},
	}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}

	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if job.Kind != model.JobCorrect || job.Total != 1 {
		t.Errorf("bad job: %+v", job)
	}

	got := waitForJob(t, s, job.ID)
	if got.State != model.StateDone {
		t.Fatalf("state = %q (error %q), want done", got.State, got.Error)
	}
	if len(got.Corrected) != 1 {
		t.Fatalf("got %d segments, want 1", len(got.Corrected))
	}
	if got.Corrected[0].Text != "JavaScript ek language hai." {
		t.Errorf("text = %q", got.Corrected[0].Text)
	}
	if got.Corrected[0].OriginalText != "javas cript ek language hai" {
		t.Errorf("OriginalText = %q, want the raw Whisper line", got.Corrected[0].OriginalText)
	}
}

// waitForJob polls until the job reaches a terminal state.
func waitForJob(t *testing.T, s *Server, id string) model.Job {
	t.Helper()

	deadline := time.Now().Add(3 * time.Second)
	var got model.Job
	for time.Now().Before(deadline) {
		r := do(t, s, http.MethodGet, "/v1/jobs/"+id, "")
		if r.Code != http.StatusOK {
			t.Fatalf("job fetch status = %d", r.Code)
		}
		if err := json.Unmarshal(r.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if got.State.Terminal() {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s never finished", id)
	return got
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

func TestVaultUploadRefusedWithoutTransport(t *testing.T) {
	f := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(f, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestServer(t, baseConfig(), nil)

	// Refused here, at submit time. When the transport was still a stub this
	// returned 202 and failed later in a worker, which meant hashing a whole
	// file before the user learned the session was unusable.
	rec := do(t, s, http.MethodPost, "/v1/vault/upload",
		jsonBody(t, map[string]string{"path": f}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestVaultAuthoriseRefusedWithoutUploader(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodPost, "/v1/vault/authorise", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestVaultLoginPollRefusedWithoutUploader(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	rec := do(t, s, http.MethodGet, "/v1/vault/authorise/abc123", "")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestVaultStatusWithoutUploaderStillAnswers(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	// Status must answer even with no transport: the UI asks it on launch to
	// decide whether to show "Connect Telegram" or "Ready".
	rec := do(t, s, http.MethodGet, "/v1/vault/status", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var st vault.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if st.Authorised {
		t.Error("authorised = true with no transport")
	}
	if st.PartBytes != vault.DefaultPartBytes {
		t.Errorf("part_bytes = %d, want %d", st.PartBytes, vault.DefaultPartBytes)
	}
}

// A session that does not exist must stop the upload here. The old behaviour
// queued it, hashed the whole 5 GB, and only then found nothing to send it with.
func TestVaultUploadRefusedWithoutASession(t *testing.T) {
	f := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(f, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestServer(t, baseConfig(), nil)
	s.deps.Vault = &vault.Vault{
		Uploader:  &unAuthorisedUploader{},
		PartSize:  vault.DefaultPartBytes,
		ChatID:    "@cloud",
		SessionOn: true,
	}

	rec := do(t, s, http.MethodPost, "/v1/vault/upload",
		jsonBody(t, map[string]string{"path": f}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "not authorised") {
		t.Errorf("body = %s, want it to say a scan is needed", rec.Body.String())
	}
}

// An authorised session with no destination is refused too: "which chat?" is not
// a question to discover while 1.9 GB is on the wire.
func TestVaultUploadRefusedWithoutADestination(t *testing.T) {
	f := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(f, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestServer(t, baseConfig(), nil)
	s.deps.Vault = &vault.Vault{
		Uploader: &authorisedUploader{},
		PartSize: vault.DefaultPartBytes,
	}

	rec := do(t, s, http.MethodPost, "/v1/vault/upload",
		jsonBody(t, map[string]string{"path": f}))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "TELEGRAM_TARGET_CHAT") {
		t.Errorf("body = %s, want it to name the missing setting", rec.Body.String())
	}
}

// stubUploader counts sends, so "accepted" can be told apart from "refused"
// without a real transport.
type stubUploader struct {
	mu   sync.Mutex
	sent int
}

func (s *stubUploader) Send(_ context.Context, _, _ string, _, _ int64) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent++
	return s.sent, nil
}

func (s *stubUploader) Authorise(context.Context) error { return nil }
func (s *stubUploader) Authorised() bool                { return false }

// authorisedUploader is a session that has been scanned.
type authorisedUploader struct{ stubUploader }

func (a *authorisedUploader) Authorised() bool { return true }

// unAuthorisedUploader is a session that has not.
type unAuthorisedUploader struct{ stubUploader }

func (u *unAuthorisedUploader) Authorised() bool { return false }

// An accepted upload must leave a job that reports byte-level progress, because
// three parts of 1.9 GB is not a progress bar.
func TestVaultJobReportsByteProgress(t *testing.T) {
	f := filepath.Join(t.TempDir(), "blob.bin")
	if err := os.WriteFile(f, make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}

	s, _ := newTestServer(t, baseConfig(), nil)
	s.deps.Vault = &vault.Vault{
		Uploader:   &authorisedUploader{},
		PartSize:   50,
		ChatID:     "@cloud",
		SessionDir: t.TempDir(),
	}

	rec := do(t, s, http.MethodPost, "/v1/vault/upload",
		jsonBody(t, map[string]string{"path": f}))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202: %s", rec.Code, rec.Body.String())
	}

	var job model.Job
	if err := json.Unmarshal(rec.Body.Bytes(), &job); err != nil {
		t.Fatal(err)
	}
	if job.Total != 2 {
		t.Errorf("total parts = %d, want 2", job.Total)
	}

	// The queue has a single worker and may take a moment, so poll rather than
	// assuming a fixed delay.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		got := do(t, s, http.MethodGet, "/v1/jobs/"+job.ID, "")
		var snapshot model.Job
		if err := json.Unmarshal(got.Body.Bytes(), &snapshot); err != nil {
			t.Fatal(err)
		}
		if snapshot.VaultProgress != nil && snapshot.VaultProgress.BytesTotal != 100 {
			t.Errorf("bytes_total = %d, want the file size", snapshot.VaultProgress.BytesTotal)
		}
		if snapshot.State.Terminal() {
			if snapshot.VaultResult == nil {
				t.Fatal("finished job has no vault_result")
			}
			if snapshot.VaultResult.ChatID != "@cloud" {
				t.Errorf("chat_id = %q, want the destination recorded", snapshot.VaultResult.ChatID)
			}
			if len(snapshot.VaultResult.MessageIDs) != 2 {
				t.Errorf("message_ids = %v, want two", snapshot.VaultResult.MessageIDs)
			}
			if p := snapshot.Progress(); p != 1 {
				t.Errorf("progress = %v, want 1 on a finished upload", p)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the upload job never reached a terminal state")
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
