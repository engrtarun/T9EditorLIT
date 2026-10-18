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
		Vault:  vault.Unconfigured(),
	}

	v, transport := buildVault(cfg, log)
	deps.Vault = v
	// The Telegram client outlives the listener on purpose: an MTProto session
	// is stateful and expensive to rebuild, so closing it on every app quit
	// would mean another QR scan. This is the one resource the daemon holds
	// open for its whole life.
	if transport != nil {
		defer transport.Close()
	}

	if cfg.HasGroq() {
		deps.Groq = cloud.NewGroq(cfg.GroqAPIKey, cfg.GroqTranscribe, cfg.GroqChat, cloud.GroqTranscribeURL)
		log.Info("transcription ready", "model", cfg.GroqTranscribe)
		if cfg.GroqChat != "" {
			log.Info("autocorrect ready", "model", cfg.GroqChat)
		} else {
			log.Warn("autocorrect disabled",
				"reason", "GROQ_CHAT_MODEL not set; transcript keeps Whisper's spelling")
		}
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
// explicitly unconfigured one otherwise.
//
// The transport is returned separately so the caller can close it: the vault
// value is copied per job for progress reporting, and copying must not lose the
// one thing that has a Close.
func buildVault(cfg *config.Config, log *slog.Logger) (*vault.Vault, *vault.Telegram) {
	v := vault.Unconfigured()

	if !cfg.HasTelegram() {
		log.Warn("telegram vault disabled", "reason", "TELEGRAM_API_ID / API_HASH not set")
		return v, nil
	}

	if err := os.MkdirAll(cfg.SessionDir, 0o700); err != nil {
		log.Error("could not create the telegram session directory",
			"dir", cfg.SessionDir, "err", err)
		return v, nil
	}

	transport := vault.New(vault.TelegramOptions{
		APIID:       cfg.TelegramAPIID,
		APIHash:     cfg.TelegramAPIHash,
		SessionDir:  cfg.SessionDir,
		Chat:        cfg.TelegramChat,
		Password:    cfg.TelegramPassword,
		Connections: cfg.TelegramConnections,
		Log:         log,
	})

	v.Uploader = transport
	v.ChatID = cfg.TelegramChat
	v.SessionDir = cfg.SessionDir
	v.SessionOn = true

	// A session on disk means the daemon can upload without the user doing
	// anything, which is the whole point of keeping it alive between launches.
	if transport.Authorised() {
		log.Info("telegram vault ready",
			"session", transport.SessionPath(),
			"chat", cfg.TelegramChat,
			"connections", transport.Connections(),
			"authorised", true)
	} else {
		log.Info("telegram vault waiting for a QR scan",
			"session", transport.SessionPath(),
			"connections", transport.Connections(),
			"authorised", false)
	}
	if !cfg.HasTelegramChat() {
		log.Warn("telegram vault has no destination chat",
			"reason", "TELEGRAM_TARGET_CHAT not set; uploads will be refused")
	}
	return v, transport
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
