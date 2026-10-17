// Command t9cloud is the local cloud worker daemon for T9EditorLIT.
//
// It owns exactly the work that should NOT live in the desktop app:
//
//   - Groq Whisper transcription jobs (chunking is done by the Rust side; this
//     daemon uploads each chunk and offsets the resulting timestamps)
//   - Gemini analysis that flags retakes, fumbles and wrong examples
//   - Telegram MTProto sessions, which must outlive the app window
//
// It binds loopback only and holds API keys, so it is never exposed to a
// network. The desktop app talks to it over plain HTTP on 127.0.0.1.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/api"
	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
	"github.com/engrtarun/T9EditorLIT/go/internal/queue"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		envPath  = flag.String("env", ".env", "path to the .env file")
		showVer  = flag.Bool("version", false, "print version and exit")
		logLevel = flag.String("log-level", "info", "debug | info | warn | error")
	)
	flag.Parse()

	if *showVer {
		fmt.Println("t9cloud", api.Version)
		return nil
	}

	log := newLogger(*logLevel)

	cfg, err := config.Load(*envPath)
	if err != nil {
		return err
	}

	// Checked before the listener starts: binding 0.0.0.0 with API keys loaded
	// must be a hard failure, not a warning.
	if err := requireLoopback(cfg.Addr); err != nil {
		return err
	}

	q := queue.New(queue.Options{
		Workers:     cfg.Workers,
		Capacity:    cfg.QueueCapacity,
		MaxAttempts: cfg.MaxAttempts,
		BaseBackoff: cfg.BaseBackoff,
	})
	defer q.Close()

	deps := api.Deps{
		Config: cfg,
		Queue:  q,
		Log:    log,
		Vault:  buildVault(cfg, log),
	}

	if cfg.HasGroq() {
		deps.Groq = cloud.NewGroq(cfg.GroqAPIKey, cfg.GroqTranscribe, cloud.GroqTranscribeURL)
		log.Info("transcription ready", "model", cfg.GroqTranscribe)
	} else {
		log.Warn("transcription disabled", "reason", "GROQ_API_KEY not set")
	}

	if cfg.HasGemini() {
		deps.Gemini = cloud.NewGemini(cfg.GeminiAPIKey, cfg.GeminiModel, cloud.GeminiBaseURL)
		log.Info("analysis ready", "model", cfg.GeminiModel)
	} else {
		log.Warn("analysis disabled", "reason", "GEMINI_API_KEY not set")
	}

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: api.New(deps),
		// Generous timeouts: cloud jobs are queued, but a client polling a job
		// status must never be cut off mid-response.
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.Addr, err)
	}

	log.Info("t9cloud listening",
		"addr", ln.Addr().String(),
		"version", api.Version,
		"workers", cfg.Workers,
		"capacity", cfg.QueueCapacity)

	errCh := make(chan error, 1)
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		return err
	case sig := <-stop:
		log.Info("shutting down", "signal", sig.String())
	}

	// Give in-flight requests a moment, then close the queue so workers stop.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Warn("graceful shutdown timed out", "err", err)
	}
	return nil
}

// buildVault returns a wired vault when Telegram credentials exist, and an
// explicitly unconfigured one otherwise. The Chunk 5 transport slots in here.
func buildVault(cfg *config.Config, log *slog.Logger) *vault.Vault {
	v := vault.Unconfigured()

	if !cfg.HasTelegram() {
		log.Warn("telegram vault disabled", "reason", "TELEGRAM_API_ID / API_HASH / TARGET_CHAT not set")
		return v
	}

	if err := os.MkdirAll(cfg.SessionDir, 0o700); err != nil {
		log.Error("could not create the telegram session directory",
			"dir", cfg.SessionDir, "err", err)
		return v
	}

	// Chunk 5 attaches the MTProto Uploader implementation here. Until then the
	// vault plans splits correctly and refuses uploads with a clear reason.
	log.Info("telegram session directory ready",
		"dir", cfg.SessionDir, "chat", cfg.TelegramChat, "transport", "pending chunk 5")
	return v
}

// requireLoopback double-checks the bind address independently of config,
// so a future edit cannot silently widen the daemon's exposure.
func requireLoopback(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("malformed T9CLOUD_ADDR %q: %w", addr, err)
	}
	ip := net.ParseIP(host)
	if host == "localhost" || (ip != nil && ip.IsLoopback()) {
		return nil
	}
	return fmt.Errorf(
		"refusing to bind %q: this daemon holds cloud API keys and has no "+
			"authentication, so it must stay on a loopback address", addr)
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}
