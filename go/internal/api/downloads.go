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
