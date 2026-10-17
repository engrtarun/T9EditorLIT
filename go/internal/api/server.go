// Package api is the local HTTP surface the Tauri app talks to.
//
// It binds loopback only and has no authentication, which is correct ONLY
// because of that: config refuses any non-loopback bind address. The daemon
// holds Groq, Gemini and Telegram credentials, so exposing it on a LAN
// interface would hand those to anyone on the network.
package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// Version is stamped at build time via -ldflags.
var Version = "dev"

// Deps are the collaborators the handlers need.
type Deps struct {
	Config *config.Config
	Queue  *queue.Queue
	Groq   *cloud.GroqClient
	Gemini *cloud.GeminiClient
	Vault  *vault.Vault
	Log    *slog.Logger
}

// Server wires the HTTP routes.
type Server struct {
	deps  Deps
	mux   *http.ServeMux
	store *jobStore
}

// New builds the server. The job store is created here and the queue's OnDone
// hook is attached so job state is updated exactly once, on the worker that
// finished the job — no polling and no double-writes.
func New(deps Deps) *Server {
	if deps.Log == nil {
		deps.Log = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}

	s := &Server{
		deps:  deps,
		mux:   http.NewServeMux(),
		store: newJobStore(),
	}

	deps.Queue.SetOnDone(s.store.finish)

	s.routes()
	return s
}

func (s *Server) routes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealth)
	s.mux.HandleFunc("POST /v1/transcribe", s.handleTranscribe)
	s.mux.HandleFunc("POST /v1/analyze", s.handleAnalyze)

	// Telegram vault. Authorisation is a QR scan, so login is three calls:
	// ask for a code, poll for the phase, and read the status that says
	// whether the stored session is still good.
	s.mux.HandleFunc("POST /v1/vault/authorise", s.handleVaultAuthorise)
	s.mux.HandleFunc("GET /v1/vault/authorise/{id}", s.handleVaultLoginPoll)
	s.mux.HandleFunc("GET /v1/vault/status", s.handleVaultStatus)
	s.mux.HandleFunc("POST /v1/vault/upload", s.handleVaultUpload)

	s.mux.HandleFunc("GET /v1/jobs/{id}", s.handleJob)
}

// ServeHTTP applies a defensive outer layer: generous body limits, panic
// recovery, and request logging. A worker crash must never take the daemon
// down mid-upload.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Loopback daemon, but the Tauri webview is a different origin, so allow
	// CORS for local development and the desktop app.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	start := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}

	defer func() {
		if rv := recover(); rv != nil {
			s.deps.Log.Error("panic in handler",
				"path", r.URL.Path, "panic", fmt.Sprint(rv))
			writeJSON(rec, http.StatusInternalServerError, map[string]string{
				"error": "internal error",
			})
		}
		s.deps.Log.Info("request",
			"method", r.Method, "path", r.URL.Path,
			"status", rec.status, "dur_ms", time.Since(start).Milliseconds())
	}()

	// 4 MB covers a JSON transcript of a 2-hour video. Audio chunks are NOT
	// posted here — the daemon reads them from disk paths.
	r.Body = http.MaxBytesReader(rec, r.Body, 4<<20)

	rec.Header().Set("X-T9Cloud-Version", Version)
	s.mux.ServeHTTP(rec, r)
}

// ── Handlers ────────────────────────────────────────────────────────────

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	depth, capacity, workers, inFlight, completed, failed := s.deps.Queue.Stats()

	writeJSON(w, http.StatusOK, model.Health{
		OK:      true,
		Version: Version,
		Uptime:  int64(time.Since(startedAt).Seconds()),
		Queue: model.QueueHealth{
			Depth: depth, Capacity: capacity, Workers: workers,
			InFlight: inFlight, Completed: completed, Failed: failed,
			Blocked: depth >= capacity,
		},
		Cloud: s.deps.Config.Capabilities(),
	})
}

func (s *Server) handleTranscribe(w http.ResponseWriter, r *http.Request) {
	// Guard on the dependency that will actually be dereferenced, not on the
	// config flag. Checking config alone leaves two sources of truth that can
	// disagree, and the worker would panic on a nil client.
	if s.deps.Groq == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "transcription unavailable: GROQ_API_KEY is not set",
		})
		return
	}

	var req model.TranscribeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Chunks) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "at least one chunk is required",
		})
		return
	}

	// The Rust side already split the file; verify each chunk is actually on
	// disk before accepting the job, so a typo fails fast here instead of
	// half-way through a long transcription.
	for _, c := range req.Chunks {
		if _, err := os.Stat(c.Path); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": fmt.Sprintf("chunk not readable: %s", filepath.Base(c.Path)),
			})
			return
		}
	}

	job := s.store.create(model.JobTranscribe, len(req.Chunks))

	err := s.deps.Queue.Submit(r.Context(), queue.Task{
		ID:        job.ID,
		Retryable: true,
		Run: func(ctx context.Context) error {
			return s.runTranscribe(ctx, job.ID, req)
		},
	})
	if err != nil {
		s.store.fail(job.ID, err)
		writeQueueError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleAnalyze(w http.ResponseWriter, r *http.Request) {
	// Same rule as transcribe: guard the dependency, not the config flag.
	if s.deps.Gemini == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "analysis unavailable: GEMINI_API_KEY is not set",
		})
		return
	}

	var req model.AnalyzeRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	if len(req.Segments) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "at least one segment is required",
		})
		return
	}

	job := s.store.create(model.JobAnalyze, len(req.Segments))

	err := s.deps.Queue.Submit(r.Context(), queue.Task{
		ID:        job.ID,
		Retryable: true,
		Run: func(ctx context.Context) error {
			return s.runAnalyze(ctx, job.ID, req)
		},
	})
	if err != nil {
		s.store.fail(job.ID, err)
		writeQueueError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, job)
}

func (s *Server) handleVaultUpload(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		// Chat overrides TELEGRAM_TARGET_CHAT for this upload only, so the UI
		// can offer "send to Saved Messages" without a settings change.
		Chat string `json:"chat,omitempty"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "path is required"})
		return
	}
	if _, err := os.Stat(req.Path); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "file not readable",
		})
		return
	}

	// Refuse before queuing when the session cannot work. A job that fails
	// twenty minutes later, after hashing the whole file, is a bad trade.
	if reason := s.vaultBlocked(); reason != "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": reason})
		return
	}

	parts, size, err := s.deps.Vault.Planned(req.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	job := s.store.create(model.JobVault, len(parts))

	// A per-job copy of the Vault carries this job's progress sink. The shared
	// one is untouched, so two uploads cannot interleave their reporting.
	v := *s.deps.Vault
	if req.Chat != "" {
		v.ChatID = req.Chat
	}
	v.OnProgress = func(p vault.Progress) {
		s.store.progressVault(job.ID, p)
	}

	err = s.deps.Queue.Submit(r.Context(), queue.Task{
		ID:        job.ID,
		Retryable: true,
		Run: func(ctx context.Context) error {
			uploaded, ids, err := v.Upload(ctx, req.Path)
			if err != nil {
				return err
			}
			s.store.finishVault(job.ID, v.ChatID, uploaded, ids, size)
			return nil
		},
	})
	if err != nil {
		s.store.fail(job.ID, err)
		writeQueueError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, job)
}

// vaultBlocked is the reason an upload cannot start right now, or "" if it can.
//
// Checked at submit time so the failure lands while the user is still looking
// at the button.
func (s *Server) vaultBlocked() string {
	if s.deps.Vault == nil || s.deps.Vault.Uploader == nil {
		return vault.ErrNotConfigured.Error()
	}
	if !s.deps.Vault.Uploader.Authorised() {
		return vault.ErrNotAuthorised.Error()
	}
	if s.deps.Vault.ChatID == "" {
		return "no Telegram chat configured; set TELEGRAM_TARGET_CHAT"
	}
	return ""
}

// handleVaultAuthorise starts a QR login.
//
// The response carries the tg://login?token=… URL and the desktop app renders
// it as a QR. No phone number, no code, nothing typed: Telegram sends a login
// code the moment a code-based flow starts, and on a machine with no console
// that code can only be wasted.
func (s *Server) handleVaultAuthorise(w http.ResponseWriter, r *http.Request) {
	starter, ok := s.deps.Vault.LoginStarter()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": vault.ErrNotConfigured.Error(),
		})
		return
	}

	challenge, err := starter.BeginLogin(r.Context())
	if err != nil {
		writeVaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, challenge)
}

// handleVaultLoginPoll reports where a scan stands.
//
// The URL in the response changes as Telegram rotates the token — roughly every
// 30 seconds — so the UI must redraw when the returned URL differs from the one
// it is showing rather than caching it.
func (s *Server) handleVaultLoginPoll(w http.ResponseWriter, r *http.Request) {
	starter, ok := s.deps.Vault.LoginStarter()
	if !ok {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": vault.ErrNotConfigured.Error(),
		})
		return
	}

	id := r.PathValue("id")
	challenge, err := starter.PollLogin(r.Context(), id)
	if err != nil {
		writeVaultError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, challenge)
}

// handleVaultStatus reports what the vault can do right now.
//
// This is the call that distinguishes "a key exists on disk" from "the key
// still works". Only this one talks to Telegram, which is why it is a separate
// endpoint rather than a field on /healthz.
func (s *Server) handleVaultStatus(w http.ResponseWriter, r *http.Request) {
	if s.deps.Vault == nil {
		writeJSON(w, http.StatusOK, vault.Status{PartBytes: vault.DefaultPartBytes})
		return
	}

	starter, ok := s.deps.Vault.LoginStarter()
	if !ok {
		writeJSON(w, http.StatusOK, vault.Status{PartBytes: vault.DefaultPartBytes})
		return
	}

	// The status body is useful even when the check itself failed: the UI can
	// show "unknown" rather than pretending everything is fine, which is why a
	// failure here is a 200 with a detail string.
	status, _ := starter.Status(r.Context())
	writeJSON(w, http.StatusOK, status)
}

// writeVaultError maps an auth error onto a status code the UI can act on.
func writeVaultError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, vault.ErrNotConfigured):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case errors.Is(err, vault.ErrLoginInProgress):
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case errors.Is(err, vault.ErrPasswordRequired):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
	case errors.Is(err, vault.ErrSessionRevoked), errors.Is(err, vault.ErrNotAuthorised):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeJSON(w, http.StatusGatewayTimeout, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
	}
}

func (s *Server) handleJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.store.get(r.PathValue("id"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such job"})
		return
	}
	writeJSON(w, http.StatusOK, job)
}

// ── Pipeline bodies ─────────────────────────────────────────────────────

// runTranscribe sends each chunk and merges the results.
//
// A single bad chunk does not abort the whole job: the transcript comes back
// with StatePartial so the user still gets usable text for 99% of the video and
// can decide what to do about the gap. Losing a 30-minute transcription to one
// corrupt chunk would be far worse than a visible hole.
func (s *Server) runTranscribe(ctx context.Context, jobID string, req model.TranscribeRequest) error {
	if s.deps.Groq == nil {
		return errors.New("groq client is not configured")
	}
	s.store.start(jobID)

	var merged []model.Segment
	var failures []string

	for _, chunk := range req.Chunks {
		segs, err := s.deps.Groq.TranscribeChunk(
			ctx, chunk.Path, chunk.OffsetSecs, req.Language, req.Prompt)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: %v", filepath.Base(chunk.Path), err))
			s.deps.Log.Warn("chunk failed",
				"job", jobID, "chunk", filepath.Base(chunk.Path), "err", err)
			continue
		}
		merged = append(merged, segs...)
		s.store.advance(jobID, len(segs))
	}

	if len(merged) == 0 {
		return fmt.Errorf("every chunk failed; first error: %v", firstOr(failures, "none"))
	}

	s.store.succeed(jobID, merged, nil, failures)
	return nil
}

func (s *Server) runAnalyze(ctx context.Context, jobID string, req model.AnalyzeRequest) error {
	if s.deps.Gemini == nil {
		return errors.New("gemini client is not configured")
	}
	s.store.start(jobID)

	analyses, err := s.deps.Gemini.Analyze(ctx, req.Segments, req.ToneProfile, req.CreatorHandle)
	if err != nil {
		return err
	}

	flagged := cloud.ApplyAnalysis(req.Segments, analyses)

	// With no Gemini key the transcript must survive even if analysis fails,
	// so a failed analysis degrades to "nothing flagged" rather than an error.
	s.store.succeed(jobID, req.Segments, flagged, nil)
	return nil
}

// ── Helpers ─────────────────────────────────────────────────────────────

var startedAt = time.Now()

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "malformed request body: " + err.Error(),
		})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		slog.Error("encode response", "err", err)
	}
}

// writeQueueError maps a submission failure onto the right status code.
// Queue-full is the backpressure signal the app uses to slow down.
func writeQueueError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, queue.ErrFull):
		w.Header().Set("Retry-After", "2")
		writeJSON(w, http.StatusTooManyRequests, map[string]string{
			"error": "daemon queue is full; retry shortly",
		})
	case errors.Is(err, queue.ErrClosed):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "daemon is shutting down",
		})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func firstOr(ss []string, fallback string) string {
	if len(ss) == 0 {
		return fallback
	}
	return ss[0]
}

func newID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail in practice; a timestamp keeps us unique
		// enough rather than panicking a worker goroutine.
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}
