package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadDefaultsToLoopback(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "absent.env"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Addr != "127.0.0.1:7878" {
		t.Errorf("Addr = %q, want 127.0.0.1:7878", cfg.Addr)
	}
	if cfg.Workers != 2 {
		t.Errorf("Workers = %d, want 2", cfg.Workers)
	}
}

func TestLoadRejectsNonLoopbackBind(t *testing.T) {
	t.Setenv("T9CLOUD_ADDR", "0.0.0.0:8787")

	if _, err := Load(""); err == nil {
		t.Fatal("expected an error binding to a non-loopback address")
	}
}

func TestLoadAcceptsLoopbackVariants(t *testing.T) {
	for _, addr := range []string{"127.0.0.1:9000", "localhost:9000", "[::1]:9000"} {
		t.Setenv("T9CLOUD_ADDR", addr)
		if _, err := Load(""); err != nil {
			t.Errorf("addr %q rejected: %v", addr, err)
		}
	}
}

func TestLoadReadsEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")

	body := `# comment line

GROQ_API_KEY="gsk_test_123"
GEMINI_API_KEY=gemini_plain
T9CLOUD_WORKERS=6
T9CLOUD_BASE_BACKOFF=250ms
export TELEGRAM_API_HASH=hashvalue
MALFORMED_LINE_NO_EQUALS
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.GroqAPIKey != "gsk_test_123" {
		t.Errorf("GroqAPIKey = %q — surrounding quotes should be stripped", cfg.GroqAPIKey)
	}
	if cfg.GeminiAPIKey != "gemini_plain" {
		t.Errorf("GeminiAPIKey = %q", cfg.GeminiAPIKey)
	}
	if cfg.TelegramAPIHash != "hashvalue" {
		t.Errorf("export prefix not handled, got %q", cfg.TelegramAPIHash)
	}
	if cfg.Workers != 6 {
		t.Errorf("Workers = %d, want 6", cfg.Workers)
	}
	if cfg.BaseBackoff != 250*time.Millisecond {
		t.Errorf("BaseBackoff = %v, want 250ms", cfg.BaseBackoff)
	}
}

func TestProcessEnvOverridesEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("GROQ_API_KEY=from_file\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("GROQ_API_KEY", "from_process")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GroqAPIKey != "from_process" {
		t.Errorf("GroqAPIKey = %q, want the process env to win", cfg.GroqAPIKey)
	}
}

func TestCapabilitiesReflectsMissingKeys(t *testing.T) {
	t.Setenv("GROQ_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "")
	t.Setenv("TELEGRAM_API_ID", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	caps := cfg.Capabilities()
	if caps["transcribe"] == "ready" {
		t.Error("transcribe should not be ready without a Groq key")
	}
	if caps["analyze"] == "ready" {
		t.Error("analyze should not be ready without a Gemini key")
	}
	if cfg.HasGroq() || cfg.HasGemini() || cfg.HasTelegram() {
		t.Error("no provider should report ready with no credentials")
	}
}

func TestAutocorrectNeedsBothGroqKeyAndChatModel(t *testing.T) {
	// A transcribe key alone must still transcribe — autocorrect is an
	// enhancement, not a dependency.
	t.Setenv("GROQ_API_KEY", "k")
	t.Setenv("GROQ_CHAT_MODEL", "")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.HasGroq() {
		t.Error("transcription should be ready with just the Groq key")
	}
	if cfg.HasAutocorrect() {
		t.Error("autocorrect cannot run without a chat model")
	}
	if cfg.Capabilities()["autocorrect"] == "ready" {
		t.Error("autocorrect capability should not advertise ready without a chat model")
	}

	t.Setenv("GROQ_CHAT_MODEL", "openai/gpt-oss-120b")
	cfg, err = Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.HasAutocorrect() {
		t.Error("autocorrect should be ready with both set")
	}
	if got := cfg.GroqChat; got != "openai/gpt-oss-120b" {
		t.Errorf("GroqChat = %q", got)
	}
}

func TestPickIntFallsBackOnGarbage(t *testing.T) {
	if got := pickInt("not-a-number", 7); got != 7 {
		t.Errorf("pickInt(garbage) = %d, want 7", got)
	}
	if got := pickInt("-3", 7); got != 7 {
		t.Errorf("pickInt(-3) = %d, want 7", got)
	}
	if got := pickInt("12", 7); got != 12 {
		t.Errorf("pickInt(12) = %d, want 12", got)
	}
}
