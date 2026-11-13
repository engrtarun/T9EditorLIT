// Package api — elevenkeys.go: CRUD for the ElevenLabs account pool.
//
// Groq and Gemini each carry one key; ElevenLabs carries a POOL of free
// accounts, and the user adds ten at a time from the app. These routes give
// that pool the same honesty the single-key routes have:
//
//	GET    /v1/keys/elevenlabs          every account, masked, with health
//	POST   /v1/keys/elevenlabs/add      probe a key, then add it for real
//	POST   /v1/keys/elevenlabs/remove   drop one account by its public id
//	POST   /v1/keys/elevenlabs/import   read a pasted .env, take its keys
//	DELETE /v1/keys/elevenlabs          clear the pool
//
// Rules inherited from keys.go: the key itself is write-only — responses and
// logs carry masks and stable hashes, never credentials — and every successful
// mutation rewrites the keys.local.env overlay and hot-swaps the live client,
// so the next chunk uses the new pool without a daemon restart.
//
// The overlay wins over .env by design (same as Groq/Gemini): the first UI
// mutation writes the FULL current pool into keys.local.env, and after that
// the app's own file is the one place a saved key lives.
package api

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
)

// handleElevenKeysList answers GET /v1/keys/elevenlabs.
//
// The pool is nil when no account is configured; an empty list is the honest
// answer, not an error — the setup panel renders from it either way.
func (s *Server) handleElevenKeysList(w http.ResponseWriter, _ *http.Request) {
	eleven := s.elevenClient()
	if eleven == nil || eleven.Pool == nil {
		writeJSON(w, http.StatusOK, map[string]any{"keys": []cloud.KeyStatus{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": eleven.Pool.Snapshot()})
}

// elevenAddRequest is the add-account body. Key is the credential under test;
// it is probed first, so a typo can never enter the pool.
type elevenAddRequest struct {
	Key string `json:"key"`
}

// handleElevenKeysAdd answers POST /v1/keys/elevenlabs/add.
//
// Probe-then-add, in that order and without a gap: the same call the Save &
// Test card makes proves the key live, the account's quota snapshot travels
// with the answer, and only then does the key join the pool, the overlay and
// the live client. An invalid key gets a 400 with the probe's sentence and
// nothing on disk changes.
func (s *Server) handleElevenKeysAdd(w http.ResponseWriter, r *http.Request) {
	var req elevenAddRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	key := strings.TrimSpace(req.Key)
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "key is required",
		})
		return
	}

	eleven := s.elevenClient()
	if eleven == nil {
		eleven = cloud.NewEleven(nil, s.deps.Config.ElevenModel, cloud.ElevenTranscribeURL, config.PoolPath(s.deps.EnvPath))
	}

	probe := eleven.Probe(r.Context(), key)
	if !probe.OK {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": probe.Detail})
		return
	}

	entry, isNew := eleven.Pool.Add(key)
	eleven.Pool.SetQuota(entry, probe.Tier, probe.QuotaUsed, probe.QuotaLimit)
	if !isNew {
		// Already in the pool — the snapshot above refreshed its quota; say so.
		s.writeElevenStatus(w, "key was already in the pool; quota refreshed")
		return
	}

	// Persist the full pool (old accounts + this one) into the overlay, then
	// hot-swap the live client from it. Order matters: overlay first, so a
	// client built from a failed swap still matches what is on disk.
	if err := s.saveElevenOverlay(eleven.Pool); err != nil {
		_ = eleven.Pool.Remove(entry.Hash)
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "could not save the key: " + err.Error(),
		})
		return
	}
	s.applyEleven(eleven.Pool.Keys())

	s.deps.Log.Info("elevenlabs key added", "pool_size", len(eleven.Pool.Keys()))
	s.writeElevenStatus(w, probe.Detail)
}

// elevenRemoveRequest drops one account by its public hash — the UI never
// holds the full key, so it identifies the row by the id the list gave it.
type elevenRemoveRequest struct {
	ID string `json:"id"`
}

// handleElevenKeysRemove answers POST /v1/keys/elevenlabs/remove.
func (s *Server) handleElevenKeysRemove(w http.ResponseWriter, r *http.Request) {
	var req elevenRemoveRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}

	eleven := s.elevenClient()
	if eleven == nil || eleven.Pool == nil {
		writeJSON(w, http.StatusOK, map[string]any{"keys": []cloud.KeyStatus{}})
		return
	}
	if !eleven.Pool.Remove(id) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such key"})
		return
	}

	if err := s.saveElevenOverlay(eleven.Pool); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "could not update the key file: " + err.Error(),
		})
		return
	}
	s.applyEleven(eleven.Pool.Keys())

	s.deps.Log.Info("elevenlabs key removed", "pool_size", len(eleven.Pool.Keys()))
	s.writeElevenStatus(w, "")
}

// handleElevenKeysClear answers DELETE /v1/keys/elevenlabs.
func (s *Server) handleElevenKeysClear(w http.ResponseWriter, _ *http.Request) {
	if _, err := config.ClearKey(s.deps.EnvPath, "elevenlabs"); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": "could not remove the keys: " + err.Error(),
		})
		return
	}
	s.applyEleven(nil)
	s.deps.Log.Info("elevenlabs pool cleared")
	writeJSON(w, http.StatusOK, map[string]any{"keys": []cloud.KeyStatus{}})
}

// handleElevenKeysProbeAll answers POST /v1/keys/elevenlabs/probe.
//
// Re-probes every account so the quota bars and health reflect the provider's
// current truth without the user re-adding a key. Probe-then-refresh: a key
// that passes gets its quota snapshot updated; one that fails (including a
// revoked credential) is reported in `failed` and left untouched otherwise.
// Concurrency is capped so ten accounts do not hammer the provider at once.
func (s *Server) handleElevenKeysProbeAll(w http.ResponseWriter, r *http.Request) {
	eleven := s.elevenClient()
	if eleven == nil || eleven.Pool == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"keys":      []cloud.KeyStatus{},
			"refreshed": 0,
			"failed":    []string{},
		})
		return
	}

	keys := eleven.Pool.Keys()
	type result struct {
		masked string
		ok     bool
	}
	results := make([]result, len(keys))

	// Cap concurrency at four: each probe is a small GET, and ten at once would
	// only trip the provider's own rate limit.
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for i, key := range keys {
		i, key := i, key
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			probe := eleven.Probe(r.Context(), key)
			entry, _ := eleven.Pool.Add(key)
			if probe.OK {
				eleven.Pool.SetQuota(entry, probe.Tier, probe.QuotaUsed, probe.QuotaLimit)
				results[i] = result{masked: maskKey(key), ok: true}
			} else {
				results[i] = result{masked: maskKey(key), ok: false}
			}
		}()
	}
	wg.Wait()

	refreshed := 0
	failed := []string{}
	for _, res := range results {
		if res.ok {
			refreshed++
		} else {
			failed = append(failed, res.masked)
		}
	}

	s.deps.Log.Info("elevenlabs probe-all", "refreshed", refreshed, "failed", len(failed))

	elevenKeys := eleven.Pool.Snapshot()
	writeJSON(w, http.StatusOK, map[string]any{
		"keys":      elevenKeys,
		"refreshed": refreshed,
		"failed":    failed,
	})
}

// elevenStateRequest toggles one account's enabled flag.
type elevenStateRequest struct {
	ID      string `json:"id"`
	Enabled *bool  `json:"enabled"`
}

// handleElevenKeysState answers POST /v1/keys/elevenlabs/state.
func (s *Server) handleElevenKeysState(w http.ResponseWriter, r *http.Request) {
	var req elevenStateRequest
	if !decodeJSON(w, r, &req) {
		return
	}
	id := strings.TrimSpace(req.ID)
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id is required"})
		return
	}
	if req.Enabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "enabled field is required"})
		return
	}

	eleven := s.elevenClient()
	if eleven == nil || eleven.Pool == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such key"})
		return
	}
	if !eleven.Pool.SetEnabled(id, *req.Enabled) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such key"})
		return
	}

	s.deps.Log.Info("elevenlabs account toggled", "id", id, "enabled", *req.Enabled)
	s.writeElevenStatus(w, "")
}

// elevenImportRequest carries a pasted .env as text, or a path to read. Both
// are optional; at least one is required. A path is read by the daemon — it
// is the same user, on the same machine, over loopback, asking the daemon to
// read a file the UI could read itself with a picker.
type elevenImportRequest struct {
	Content string `json:"content,omitempty"`
	Path    string `json:"path,omitempty"`
}

// elevenImportResult is the per-item truth the panel renders: which keys went
// in, which the provider rejected, and which services were picked up along
// the way. Partial success is normal here — a hand-maintained .env often has
// one stale key among ten good ones.
type elevenImportResult struct {
	Added     []string `json:"added"`
	Rejected  []string `json:"rejected"`
	Duplicate int      `json:"duplicate"`
	Groq      bool     `json:"groq_updated"`
	Gemini    bool     `json:"gemini_updated"`
}

// handleElevenKeysImport answers POST /v1/keys/elevenlabs/import.
//
// ELEVENLABS_API_KEYS is the point of the call, but GROQ_API_KEY and
// GEMINI_API_KEY in the same file are first-class citizens: importing them
// into their overlays saves the user a second round through the setup cards.
// Only these three are read — every other variable in the file is ignored,
// because a secrets import must never be a general config import.
func (s *Server) handleElevenKeysImport(w http.ResponseWriter, r *http.Request) {
	var req elevenImportRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	content := req.Content
	if content == "" {
		if req.Path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "paste the .env contents or give a path",
			})
			return
		}
		// A 1 MiB cap: a real .env is a few kilobytes, and this endpoint must
		// never become a file reader.
		raw, err := os.ReadFile(req.Path)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{
				"error": "could not read " + filepath.Base(req.Path) + ": " + err.Error(),
			})
			return
		}
		content = string(raw)
	}
	if len(content) > 1<<20 {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "file is too large to be an .env",
		})
		return
	}

	vars := config.ParseEnvText(content)
	res := elevenImportResult{Added: []string{}, Rejected: []string{}}

	// Groq and Gemini first: their flow is single-key and already proven.
	if key := strings.TrimSpace(vars["GROQ_API_KEY"]); key != "" {
		if _, err := config.SetKey(s.deps.EnvPath, "groq", key); err == nil {
			s.applyKey("groq", key)
			res.Groq = true
		}
	}
	if key := strings.TrimSpace(vars["GEMINI_API_KEY"]); key != "" {
		if _, err := config.SetKey(s.deps.EnvPath, "gemini", key); err == nil {
			s.applyKey("gemini", key)
			res.Gemini = true
		}
	}

	keys := parseKeyListValue(vars["ELEVENLABS_API_KEYS"])
	if len(keys) == 0 && !res.Groq && !res.Gemini {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "no ELEVENLABS_API_KEYS, GROQ_API_KEY or GEMINI_API_KEY in that file",
		})
		return
	}

	eleven := s.elevenClient()
	if eleven == nil {
		eleven = cloud.NewEleven(nil, s.deps.Config.ElevenModel, cloud.ElevenTranscribeURL, config.PoolPath(s.deps.EnvPath))
	}

	for _, key := range keys {
		probe := eleven.Probe(r.Context(), key)
		if !probe.OK {
			res.Rejected = append(res.Rejected, maskKey(key))
			continue
		}
		entry, isNew := eleven.Pool.Add(key)
		eleven.Pool.SetQuota(entry, probe.Tier, probe.QuotaUsed, probe.QuotaLimit)
		if isNew {
			res.Added = append(res.Added, maskKey(key))
		} else {
			res.Duplicate++
		}
	}

	if len(res.Added) > 0 {
		if err := s.saveElevenOverlay(eleven.Pool); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{
				"error": "could not save the keys: " + err.Error(),
			})
			return
		}
		s.applyEleven(eleven.Pool.Keys())
	}

	s.deps.Log.Info("elevenlabs env import",
		"added", len(res.Added), "rejected", len(res.Rejected),
		"duplicate", res.Duplicate, "groq", res.Groq, "gemini", res.Gemini)
	writeJSON(w, http.StatusOK, res)
}

// saveElevenOverlay writes the pool's full key set into the overlay variable.
// The overlay wins over .env, so after the first UI edit the app's own file
// is the one place the accounts live — the same contract the setup cards use.
func (s *Server) saveElevenOverlay(pool *cloud.KeyPool) error {
	keys := pool.Keys()
	if len(keys) == 0 {
		if _, err := config.ClearKey(s.deps.EnvPath, "elevenlabs"); err != nil {
			return err
		}
		return nil
	}
	_, err := config.SetKey(s.deps.EnvPath, "elevenlabs", strings.Join(keys, ","))
	return err
}

// applyEleven rebuilds the live ElevenLabs client from a key list. The pool
// file carries the health stats across rebuilds, so swapping never resets
// cooldowns or forgets which account did the work.
func (s *Server) applyEleven(keys []string) {
	if len(keys) == 0 {
		s.applyKey("elevenlabs", "")
		return
	}
	s.applyKey("elevenlabs", strings.Join(keys, ","))
}

// writeElevenStatus answers with the pool snapshot plus a one-line note.
func (s *Server) writeElevenStatus(w http.ResponseWriter, note string) {
	eleven := s.elevenClient()
	var keys []cloud.KeyStatus
	if eleven != nil && eleven.Pool != nil {
		keys = eleven.Pool.Snapshot()
	} else {
		keys = []cloud.KeyStatus{}
	}
	if note == "" {
		writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys, "note": note})
}
