package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeEnv creates a .env with the given body and returns its path.
func writeEnv(t *testing.T, body string) string {
	t.Helper()

	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write .env: %v", err)
	}
	return path
}

func TestSavedKeyBeatsFileAndProcessEnv(t *testing.T) {
	envPath := writeEnv(t, "GROQ_API_KEY=from_file\nGEMINI_API_KEY=gem_from_file\n")

	// This machine really does export GEMINI_API_KEY at user scope. The
	// overlay must beat it, or a key deleted in the UI would come back on the
	// next launch and the card would look broken.
	t.Setenv("GEMINI_API_KEY", "from_process")

	path, err := SetKey(envPath, "gemini", "from_ui")
	if err != nil {
		t.Fatalf("SetKey: %v", err)
	}
	if want := filepath.Join(filepath.Dir(envPath), KeysLocalName); path != want {
		t.Errorf("SetKey wrote %q, want %q", path, want)
	}

	cfg, err := Load(envPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GeminiAPIKey != "from_ui" {
		t.Errorf("GeminiAPIKey = %q, want the saved overlay key", cfg.GeminiAPIKey)
	}

	// A key the overlay does not mention keeps the old order: process env
	// still beats the file.
	t.Setenv("GROQ_API_KEY", "groq_from_process")
	cfg, err = Load(envPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.GroqAPIKey != "groq_from_process" {
		t.Errorf("GroqAPIKey = %q, want the process env to win", cfg.GroqAPIKey)
	}
}

func TestClearedKeyStaysCleared(t *testing.T) {
	envPath := writeEnv(t, "GEMINI_API_KEY=still_in_dot_env\n")
	t.Setenv("GEMINI_API_KEY", "")

	if _, err := ClearKey(envPath, "gemini"); err != nil {
		t.Fatalf("ClearKey: %v", err)
	}

	cfg, err := Load(envPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	// An absent overlay line would fall back to .env; the explicit empty
	// value is what makes the removal real.
	if cfg.GeminiAPIKey != "" {
		t.Errorf("GeminiAPIKey = %q — a removed key must not come back from .env", cfg.GeminiAPIKey)
	}
	if cfg.HasGemini() {
		t.Error("HasGemini must be false after the key was removed")
	}
}

func TestSetKeyLeavesOtherLinesUntouched(t *testing.T) {
	envPath := writeEnv(t, "GROQ_API_KEY=old\n")
	t.Setenv("GROQ_API_KEY", "")

	if _, err := SetKey(envPath, "groq", "new-key"); err != nil {
		t.Fatalf("SetKey: %v", err)
	}
	// Replace again: the file must not grow a second GROQ_API_KEY line.
	if _, err := SetKey(envPath, "groq", "newer-key"); err != nil {
		t.Fatalf("SetKey (replace): %v", err)
	}

	data, err := os.ReadFile(KeysPath(envPath))
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	if n := strings.Count(string(data), "GROQ_API_KEY="); n != 1 {
		t.Errorf("overlay holds %d GROQ_API_KEY lines, want exactly 1\n%s", n, data)
	}
	if strings.Contains(string(data), "old") {
		t.Errorf("stale value left behind:\n%s", data)
	}

	// The user's .env is never a write target.
	envData, err := os.ReadFile(envPath)
	if err != nil {
		t.Fatalf("read .env: %v", err)
	}
	if string(envData) != "GROQ_API_KEY=old\n" {
		t.Errorf(".env was modified: %q", envData)
	}
}

func TestSetKeyRefusesJunk(t *testing.T) {
	envPath := writeEnv(t, "")

	if _, err := SetKey(envPath, "openai", "sk-1"); err == nil {
		t.Error("an unknown service must be refused")
	}
	if _, err := SetKey(envPath, "groq", "   "); err == nil {
		t.Error("an empty key must be refused (ClearKey is the way to remove one)")
	}
	if _, err := SetKey(envPath, "groq", "line1\nline2"); err == nil {
		t.Error("a key containing a newline must be refused: it would forge a second line")
	}
	if _, err := ClearKey(envPath, "telegram"); err == nil {
		t.Error("ClearKey must refuse an unknown service too")
	}
}
