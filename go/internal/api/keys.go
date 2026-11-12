// Package api — keys.go: CRUD for the provider credentials.
//
// Three routes, one rule: the key itself is write-only.
//
//	GET    /v1/keys          what is configured, with each key masked
//	PUT    /v1/keys/{service} save a key (groq | gemini) and use it now
//	DELETE /v1/keys/{service} remove a key and stop using it
//
// Nothing here ever returns a full key — `masked` shows a prefix and the last
// four characters, which is enough to tell two keys apart and short enough
// that a screenshot cannot leak a credential. Saving writes the overlay file
// (config.SetKey), never the user's `.env`, and the swap happens under one
// lock so a job in flight can never observe a half-updated client.
//
// The hot swap matters: the app has no "restart the daemon" button, so a key
// pasted into the UI must take effect on the very next call rather than the
// next launch.
package api

import (
	"net/http"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
)

// keyState is one credential as the UI may see it: existence, shape, model.
type keyState struct {
	Service    string `json:"service"`
	Configured bool   `json:"configured"`
	Masked     string `json:"masked,omitempty"`
	Model      string `json:"model,omitempty"`
	// ChatModel is Groq's autocorrect model — a separate switch, because
	// transcription must keep working when only autocorrect is disabled.
	ChatModel string `json:"chatModel,omitempty"`
	// Count is how many accounts the ElevenLabs pool holds. The panel uses
	// the richer /v1/keys/elevenlabs view; this keeps the flat key list honest.
	Count int `json:"count,omitempty"`
}

// keyStates reports the providers under keysMu, so the list cannot disagree
// with what the pipeline handlers will actually use.
func (s *Server) keyStates() []keyState {
	s.keysMu.RLock()
	defer s.keysMu.RUnlock()

	cfg := s.deps.Config
	out := make([]keyState, 0, 3)

	groq := keyState{Service: "groq", Configured: cfg.GroqAPIKey != ""}
	if groq.Configured {
		groq.Masked = maskKey(cfg.GroqAPIKey)
		groq.Model = cfg.GroqTranscribe
		groq.ChatModel = cfg.GroqChat
	}
	out = append(out, groq)

	gemini := keyState{Service: "gemini", Configured: cfg.GeminiAPIKey != ""}
	if gemini.Configured {
		gemini.Masked = maskKey(cfg.GeminiAPIKey)
		gemini.Model = cfg.GeminiModel
	}
	out = append(out, gemini)

	eleven := keyState{
		Service:    "elevenlabs",
		Configured: len(cfg.ElevenAPIKeys) > 0,
		Model:      cfg.ElevenModel,
		Count:      len(cfg.ElevenAPIKeys),
	}
	if eleven.Configured {
		// The pool masks each key the same way; the flat list shows the first
		// and a count, which is enough to recognise "which accounts exist".
		eleven.Masked = maskKey(cfg.ElevenAPIKeys[0])
	}
	return append(out, eleven)
}

// handleKeysList answers GET /v1/keys.
func (s *Server) handleKeysList(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"keys": s.keyStates()})
}

// handleKeysSave answers PUT /v1/keys/{service}.
//
// The probe is intentionally NOT run here: saving a key the user just pasted
// should succeed even when Groq is rate-limiting, and the existing
// POST /v1/keys/probe is the honest place to ask "does it work". Two jobs,
// two answers, no endpoint that quietly half-fails.
func (s *Server) handleKeysSave(w http.ResponseWriter, r *http.Request) {
	service := strings.ToLower(strings.TrimSpace(r.PathValue("service")))
	if _, ok := config.ValidKeyService(service); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unknown service: use \"groq\", \"gemini\" or \"elevenlabs\"",
		})
		return
	}

	var req struct {
		Key string `json:"key"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}

	key := strings.TrimSpace(req.Key)
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "key is required (use DELETE to remove one)",
		})
		return
	}

	// Written first: if the file cannot be stored, nothing has changed and the
	// user is told the truth instead of getting a key that dies on restart.
	if _, err := config.SetKey(s.deps.EnvPath, service, key); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "could not save the key: " + err.Error(),
		})
		return
	}

	s.applyKey(service, key)
	s.deps.Log.Info("key saved", "service", service, "configured", true)

	for _, st := range s.keyStates() {
		if st.Service == service {
			writeJSON(w, http.StatusOK, st)
			return
		}
	}
	writeJSON(w, http.StatusOK, keyState{Service: service, Configured: true, Masked: maskKey(key)})
}

// handleKeysDelete answers DELETE /v1/keys/{service}.
func (s *Server) handleKeysDelete(w http.ResponseWriter, r *http.Request) {
	service := strings.ToLower(strings.TrimSpace(r.PathValue("service")))
	if _, ok := config.ValidKeyService(service); !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unknown service: use \"groq\", \"gemini\" or \"elevenlabs\"",
		})
		return
	}

	if _, err := config.ClearKey(s.deps.EnvPath, service); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "could not remove the key: " + err.Error(),
		})
		return
	}

	s.applyKey(service, "")
	s.deps.Log.Info("key removed", "service", service)

	writeJSON(w, http.StatusOK, keyState{Service: service, Configured: false})
}

// applyKey swaps the live client and the config flag together, under the one
// lock the pipeline handlers read through. A nil key builds no client at all,
// which is exactly what the nil guards in the pipeline check for — so
// "removed" and "never set" behave identically.
func (s *Server) applyKey(service, key string) {
	s.keysMu.Lock()
	defer s.keysMu.Unlock()

	cfg := s.deps.Config
	usage := s.deps.Usage

	switch service {
	case "groq":
		cfg.GroqAPIKey = key
		if key == "" {
			s.deps.Groq = nil
			return
		}
		client := cloud.NewGroq(key, cfg.GroqTranscribe, cfg.GroqChat, cloud.GroqTranscribeURL)
		// The new client gets the same usage recorder as any other: calls made
		// after a key swap count towards the same gauge.
		cloud.WithUsage(client.HTTP, "groq", usage)
		s.deps.Groq = client
	case "gemini":
		cfg.GeminiAPIKey = key
		if key == "" {
			s.deps.Gemini = nil
			return
		}
		client := cloud.NewGemini(key, cfg.GeminiModel, cloud.GeminiBaseURL)
		cloud.WithUsage(client.HTTP, "gemini", usage)
		s.deps.Gemini = client
	case "elevenlabs":
		// The value is the pool as one comma-joined list; "" clears it. The
		// client rebuild reads the pool file back, so usage counts, cooldowns
		// and disabled flags survive every swap (NewKeyPool → restore).
		keys := parseKeyListValue(key)
		cfg.ElevenAPIKeys = keys
		if len(keys) == 0 {
			s.deps.Eleven = nil
			return
		}
		client := cloud.NewEleven(keys, cfg.ElevenModel, cloud.ElevenTranscribeURL, config.PoolPath(s.deps.EnvPath))
		cloud.WithUsage(client.HTTP, "elevenlabs", usage)
		s.deps.Eleven = client
	}
}

// parseKeyListValue splits the overlay's comma-joined pool back into keys.
// It tolerates newlines and stray semicolons for hand-edited values; empty
// and duplicate entries are dropped, exactly like config-time parsing.
func parseKeyListValue(joined string) []string {
	fields := strings.FieldsFunc(joined, func(r rune) bool {
		return r == ',' || r == ';' || r == '\n' || r == '\r'
	})
	seen := make(map[string]struct{}, len(fields))
	out := make([]string, 0, len(fields))
	for _, k := range fields {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if _, dup := seen[k]; dup {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	return out
}

// maskKey shows enough to recognise a credential and not enough to use it.
//
// A short key is fully hidden: eight characters of a secret is eight too many
// when the only thing they identify is "some key".
func maskKey(key string) string {
	key = strings.TrimSpace(key)
	switch {
	case key == "":
		return ""
	case len(key) <= 8:
		return strings.Repeat("•", 4)
	default:
		return key[:4] + "…" + key[len(key)-4:]
	}
}
