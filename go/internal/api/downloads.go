package api

import (
	"errors"
	"net/http"

	"github.com/engrtarun/T9EditorLIT/go/internal/dl"
)

// handleDLList returns the whole download queue. The frontend polls this
// while anything is running (800 ms) — the numbers it draws are the ones the
// downloader counts, so a paused row's bar stops exactly where the writer
// stopped.
func (s *Server) handleDLList(w http.ResponseWriter, _ *http.Request) {
	if s.deps.DL == nil {
		writeJSON(w, http.StatusOK, []dl.Item{})
		return
	}
	writeJSON(w, http.StatusOK, s.deps.DL.List())
}

// handleDLStart queues a multi-segment download.
//
// Body: {"url": "...", "referer": "..."} — the referer is forwarded to the
// server because some hosts refuse a request with no referrer at all.
func (s *Server) handleDLStart(w http.ResponseWriter, r *http.Request) {
	if s.deps.DL == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "downloader unavailable",
		})
		return
	}
	var req struct {
		URL     string `json:"url"`
		Referer string `json:"referer"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.URL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "url is required"})
		return
	}

	item, err := s.deps.DL.Start(req.URL, req.Referer)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, item)
}

// handleDLSettingsGet reports what the queue is *actually* using. The app
// stores the user's choice in SQLite and pushes it here; this answer is what
// the UI compares against, so a stale database row cannot make the panel lie
// about the socket count or the destination folder.
func (s *Server) handleDLSettingsGet(w http.ResponseWriter, _ *http.Request) {
	if s.deps.DL == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "downloader unavailable",
		})
		return
	}
	writeJSON(w, http.StatusOK, s.deps.DL.Settings())
}

// handleDLSettingsSave applies connections / save folder / auto-resume.
//
// Only the next download is affected: a running row keeps the split it
// started with, because moving a live writer's range is how two connections
// land on the same bytes. The reply is the resolved settings (absolute folder,
// clamped connections), not a bare 200.
func (s *Server) handleDLSettingsSave(w http.ResponseWriter, r *http.Request) {
	if s.deps.DL == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "downloader unavailable",
		})
		return
	}
	var in dl.Settings
	if !decodeJSON(w, r, &in) {
		return
	}
	out, err := s.deps.DL.ApplySettings(in)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// handleDLAction is pause / resume / cancel on one row: POST
// /v1/dl/{id}/{action}.
func (s *Server) handleDLAction(w http.ResponseWriter, r *http.Request) {
	if s.deps.DL == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "downloader unavailable",
		})
		return
	}

	id := r.PathValue("id")
	var (
		item *dl.Item
		err  error
	)
	switch r.PathValue("action") {
	case "pause":
		item, err = s.deps.DL.Pause(id)
	case "resume":
		item, err = s.deps.DL.Resume(id)
	case "cancel":
		item, err = s.deps.DL.Cancel(id)
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unknown action; use pause, resume or cancel",
		})
		return
	}

	switch {
	case errors.Is(err, dl.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such download"})
	case errors.Is(err, dl.ErrBusy):
		// The state moved under the click (finished between polls). The
		// caller re-polls the list anyway, so a 409 is honest, not fatal.
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusOK, item)
	}
}
