// Package config — keysfile.go: where a key saved from the UI lives.
//
// The user can now add, replace and remove an API key from the app itself.
// Editing the user's own `.env` would be the obvious place, and it is the
// wrong one: that file is hand-maintained, it is under version control, and
// a deploy or a git checkout could silently take somebody's credential away.
//
// So keys saved from the UI go into a small overlay file next to it:
//
//	<dir>/keys.local.env   ← wins, written only by the app
//	<dir>.env              ← still the user's, never written by the app
//
// An explicit empty value is how "removed" is recorded, because an absent
// line would fall back to .env and the key would come back from the dead.
// The file is created with 0600 and written atomically (temp + rename), so a
// crash mid-save can never leave a half-written credential on disk.
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// KeysLocalName is the overlay's fixed name. It is deliberately not
// configurable: the app has to find it without asking anyone.
const KeysLocalName = "keys.local.env"

// keyVars maps a service name the HTTP layer understands to the variable it
// must set. Anything else is refused by SetKey rather than written.
//
// "elevenlabs" is a POOL: its variable holds a comma-joined list of keys, one
// per account. The HTTP layer joins and splits it; this file only sees text.
var keyVars = map[string]string{
	"groq":       "GROQ_API_KEY",
	"gemini":     "GEMINI_API_KEY",
	"elevenlabs": "ELEVENLABS_API_KEYS",
}

// ValidKeyService is the one place the HTTP layer's service names are
// checked, so a route, a save and a delete can never disagree about what
// "groq" means. It returns the env var the service maps to.
func ValidKeyService(service string) (string, bool) {
	name, ok := keyVars[strings.ToLower(strings.TrimSpace(service))]
	return name, ok
}

// KeysPath returns the overlay path that sits beside the given .env path.
func KeysPath(envPath string) string {
	if envPath == "" {
		return KeysLocalName
	}
	return filepath.Join(filepath.Dir(envPath), KeysLocalName)
}

// PoolPath returns the key pool's stats file, beside the overlay. It is
// "eleven.pool.json" by the same rule as KeysLocalName: the app has to find
// it without asking anyone. The pool writes usage counts, cooldowns and key
// health there, so rotating accounts keeps its memory across daemon restarts.
func PoolPath(envPath string) string {
	if envPath == "" {
		return "eleven.pool.json"
	}
	return filepath.Join(filepath.Dir(envPath), "eleven.pool.json")
}

// SetKey saves a key for one service into the overlay and returns the file it
// wrote. An empty key is refused here — clearing is ClearKey's job, so a
// blank form field can never erase a working credential.
func SetKey(envPath, service, key string) (string, error) {
	name, ok := ValidKeyService(service)
	if !ok {
		return "", fmt.Errorf("unknown service %q (want groq, gemini or elevenlabs)", service)
	}
	key = strings.TrimSpace(key)
	if key == "" {
		return "", fmt.Errorf("empty key: nothing to save")
	}
	if strings.ContainsAny(key, "\r\n") {
		return "", fmt.Errorf("key contains a line break")
	}

	path := KeysPath(envPath)
	if err := writeOverlay(path, name, key); err != nil {
		return "", err
	}
	return path, nil
}

// ClearKey records an explicit empty value so the provider is genuinely
// unconfigured after a reload, instead of reverting to whatever .env holds.
func ClearKey(envPath, service string) (string, error) {
	name, ok := ValidKeyService(service)
	if !ok {
		return "", fmt.Errorf("unknown service %q (want groq, gemini or elevenlabs)", service)
	}
	path := KeysPath(envPath)
	if err := writeOverlay(path, name, ""); err != nil {
		return "", err
	}
	return path, nil
}

// writeOverlay replaces (or adds) one KEY=value line, leaving every other
// line exactly as it found it.
func writeOverlay(path, varName, value string) error {
	lines := []string{
		"# Keys saved from the T9 Editor LIT app. This file overrides .env;",
		"# it is written only by the app. Delete a line to fall back to .env.",
	}

	found := false
	if existing, err := readLines(path); err == nil {
		for _, line := range existing {
			key, _, ok := strings.Cut(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "export ")), "=")
			if !ok || strings.TrimSpace(key) != varName {
				lines = append(lines, line)
				continue
			}
			found = true
			lines = append(lines, varName+"="+value)
		}
	}
	if !found {
		lines = append(lines, varName+"="+value)
	}

	return writeLinesAtomic(path, lines)
}

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	return out, sc.Err()
}

// writeLinesAtomic writes with 0600 permissions and renames into place, so a
// key is never observable in a partially-written file.
func writeLinesAtomic(path string, lines []string) error {
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}

	tmp, err := os.CreateTemp(dir, ".keys-*")
	if err != nil {
		return fmt.Errorf("create temp overlay: %w", err)
	}
	tmpName := tmp.Name()

	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()

	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return fmt.Errorf("restrict overlay: %w", err)
	}
	for _, line := range lines {
		if _, err := tmp.WriteString(line + "\n"); err != nil {
			tmp.Close()
			return fmt.Errorf("write overlay: %w", err)
		}
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close overlay: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace %s: %w", path, err)
	}
	tmpName = "" // the rename succeeded; the deferred remove must not fire
	return nil
}
