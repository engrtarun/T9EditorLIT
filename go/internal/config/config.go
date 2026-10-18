// Package config loads daemon settings from the environment.
//
// The daemon reads the SAME .env file as the Tauri app — one place for secrets,
// and the desktop app can then display which integrations are live without
// duplicating the key list.
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config is the fully resolved daemon configuration.
type Config struct {
	// Addr is the listen address. It defaults to loopback and MUST stay on
	// loopback: this daemon holds Groq, Gemini and Telegram credentials and
	// exposes no authentication of its own.
	Addr string

	// Workers bounds concurrent cloud jobs.
	Workers int
	// QueueCapacity bounds pending jobs before Submit starts refusing work.
	QueueCapacity int
	// MaxAttempts is total tries per job including the first.
	MaxAttempts int
	// BaseBackoff is the first retry delay.
	BaseBackoff time.Duration

	// GroqAPIKey and friends enable the transcription pipeline.
	GroqAPIKey     string
	GroqTranscribe string
	GroqMaxChunkMB int
	// GroqChat is the text model behind transcript autocorrect. Empty disables
	// the pass; the transcript still arrives, just with Whisper's spelling.
	GroqChat string
	// GeminiAPIKey and friends enable the analysis pipeline.
	GeminiAPIKey string
	GeminiModel  string
	// Telegram credentials enable the Chunk 5 vault.
	TelegramAPIID   int
	TelegramAPIHash string
	TelegramChat    string
	// TelegramPassword is the account's Two-Step Verification cloud password.
	//
	// There is deliberately no phone-number setting: authorisation happens by
	// scanning a QR from an already-logged-in phone, so no login code is ever
	// requested and none can be wasted. 2FA is the only thing a scan cannot
	// cover, and it needs this one value.
	TelegramPassword string
	// TelegramConnections is how many MTProto connections share one auth key.
	// This is the bandwidth-delay fix: one socket cannot fill a home uplink.
	TelegramConnections int
	// SessionDir holds the MTProto session file so it survives a restart.
	SessionDir string
}

// APIBaseURLs are overridable so tests can point at an httptest server.
type Endpoints struct {
	Groq   string
	Gemini string
}

// Default endpoints for the real providers.
const (
	GroqTranscribeURL = "https://api.groq.com/openai/v1/audio/transcriptions"
	GeminiBaseURL     = "https://generativelanguage.googleapis.com/v1beta/models"
)

// Load reads .env from the given path and the process environment.
//
// Process environment wins over .env so a user can override a single value in
// CI without editing the file.
func Load(envPath string) (*Config, error) {
	fileVars, err := readEnvFile(envPath)
	if err != nil {
		return nil, err
	}

	get := func(key string) string {
		if v, ok := os.LookupEnv(key); ok && v != "" {
			return v
		}
		return fileVars[key]
	}

	cfg := &Config{
		Addr:                pick(get("T9CLOUD_ADDR"), "127.0.0.1:8787"),
		Workers:             pickInt(get("T9CLOUD_WORKERS"), 2),
		QueueCapacity:       pickInt(get("T9CLOUD_QUEUE_CAPACITY"), 32),
		MaxAttempts:         pickInt(get("T9CLOUD_MAX_ATTEMPTS"), 3),
		BaseBackoff:         pickDuration(get("T9CLOUD_BASE_BACKOFF"), time.Second),
		GroqAPIKey:          get("GROQ_API_KEY"),
		GroqTranscribe:      pick(get("GROQ_TRANSCRIBE_MODEL"), "whisper-large-v3"),
		GroqMaxChunkMB:      pickInt(get("GROQ_MAX_CHUNK_MB"), 15),
		GroqChat:            get("GROQ_CHAT_MODEL"),
		GeminiAPIKey:        get("GEMINI_API_KEY"),
		GeminiModel:         pick(get("GEMINI_MODEL"), "gemini-2.5-flash"),
		TelegramAPIID:       pickInt(get("TELEGRAM_API_ID"), 0),
		TelegramAPIHash:     get("TELEGRAM_API_HASH"),
		TelegramChat:        get("TELEGRAM_TARGET_CHAT"),
		TelegramPassword:    get("TELEGRAM_2FA_PASSWORD"),
		TelegramConnections: pickInt(get("TELEGRAM_CONNECTIONS"), 3),
		SessionDir:          pick(get("T9CLOUD_SESSION_DIR"), defaultSessionDir()),
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if !isLoopback(c.Addr) {
		return fmt.Errorf(
			"T9CLOUD_ADDR must bind a loopback address (got %q): "+
				"this daemon holds cloud API keys and has no authentication",
			c.Addr)
	}
	if c.Workers < 1 {
		return fmt.Errorf("T9CLOUD_WORKERS must be >= 1, got %d", c.Workers)
	}
	if c.QueueCapacity < 1 {
		return fmt.Errorf("T9CLOUD_QUEUE_CAPACITY must be >= 1, got %d", c.QueueCapacity)
	}
	return nil
}

// HasGroq reports whether transcription is usable.
func (c *Config) HasGroq() bool { return c.GroqAPIKey != "" }

// HasAutocorrect reports whether the spelling pass can run.
//
// Separate from HasGroq on purpose: transcription works with a transcribe key
// alone, and losing autocorrect must not disable it.
func (c *Config) HasAutocorrect() bool { return c.GroqAPIKey != "" && c.GroqChat != "" }

// HasGemini reports whether analysis is usable.
func (c *Config) HasGemini() bool { return c.GeminiAPIKey != "" }

// HasTelegram reports whether the vault transport can be built at all.
//
// API credentials alone are enough to log in by QR; the destination chat is
// only needed to upload, so the two are checked separately and the UI can tell
// the user which half is missing.
func (c *Config) HasTelegram() bool {
	return c.TelegramAPIID != 0 && c.TelegramAPIHash != ""
}

// HasTelegramChat reports whether uploads have somewhere to go.
func (c *Config) HasTelegramChat() bool { return c.TelegramChat != "" }

// Capabilities describes which pipelines are live, for GET /healthz.
func (c *Config) Capabilities() map[string]string {
	out := map[string]string{}
	out["transcribe"] = status(c.HasGroq(), "ready", "GROQ_API_KEY not set")
	out["autocorrect"] = status(c.HasAutocorrect(), "ready", "GROQ_CHAT_MODEL not set")
	out["analyze"] = status(c.HasGemini(), "ready", "GEMINI_API_KEY not set")
	out["vault"] = status(c.HasTelegram(), "ready", "TELEGRAM_API_ID / API_HASH not set")
	out["vault_upload"] = status(c.HasTelegramChat(), "ready", "TELEGRAM_TARGET_CHAT not set")
	return out
}

func status(ok bool, ready, missing string) string {
	if ok {
		return ready
	}
	return missing
}

// defaultSessionDir sits next to the app's other local data.
func defaultSessionDir() string {
	if v := os.Getenv("T9EDITOR_DATA_DIR"); v != "" {
		return filepath.Join(v, "telegram")
	}
	return filepath.Join(os.TempDir(), "t9editorlit", "telegram")
}

// readEnvFile parses a dotenv file. Missing files are not an error — the daemon
// is perfectly happy running from environment variables alone.
func readEnvFile(path string) (map[string]string, error) {
	if path == "" {
		return map[string]string{}, nil
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	vars := map[string]string{}
	sc := bufio.NewScanner(f)
	line := 0

	for sc.Scan() {
		line++
		raw := strings.TrimSpace(sc.Text())
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		raw = strings.TrimPrefix(raw, "export ")

		key, val, ok := strings.Cut(raw, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)

		// Strip matching quotes so `KEY="v"` and KEY=v behave the same.
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		vars[key] = val
	}

	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s (line %d): %w", path, line, err)
	}
	return vars, nil
}

func isLoopback(addr string) bool {
	host := addr
	if i := strings.LastIndex(addr, ":"); i != -1 {
		host = addr[:i]
	}
	host = strings.Trim(host, "[]")

	switch host {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return strings.HasPrefix(host, "127.")
	}
}

func pick(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func pickInt(v string, fallback int) int {
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func pickDuration(v string, fallback time.Duration) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}
