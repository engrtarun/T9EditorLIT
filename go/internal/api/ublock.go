package api

import (
	"net/http"

	"github.com/engrtarun/T9EditorLIT/go/internal/ublock"
)

// handleUBlockStatus reports the installed ad blocker without touching the
// network. The panel polls this while its settings popover is open, and the
// fields are the honest disk truth: `installed`, the version, and the reason
// the last check failed (if it did).
func (s *Server) handleUBlockStatus(w http.ResponseWriter, _ *http.Request) {
	if s.deps.UBlock == nil {
		writeJSON(w, http.StatusOK, ublock.Status{
			Enabled:    false,
			AutoUpdate: false,
			Error:      "uBlock updater is not running in this daemon build",
		})
		return
	}
	writeJSON(w, http.StatusOK, s.deps.UBlock.Status())
}

// handleUBlockUpdate forces a check now. It answers immediately with the
// current status (`updating: true`) because the GitHub call belongs in the
// background; the UI polls GET /v1/ublock/status for the result.
func (s *Server) handleUBlockUpdate(w http.ResponseWriter, r *http.Request) {
	if s.deps.UBlock == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "uBlock updater is not running in this daemon build",
		})
		return
	}
	writeJSON(w, http.StatusAccepted, s.deps.UBlock.UpdateNow(r.Context()))
}
