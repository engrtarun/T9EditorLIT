// Package api — keys_probe.go: the HTTP half of the key check.
//
// cloud/probe.go does the talking to the providers; this file is only the
// routing. The body carries the key under test, it is used for exactly one
// models-list call, and it is never logged or echoed back. An empty body key
// means "re-verify what this daemon was started with", which is how the UI
// re-checks a saved credential.
//
// The outcome is always a 200 with the ProbeResult JSON — one call in, one
// human sentence out. A probe that answers "your key is dead" is still a
// successful probe; only a malformed request is an error status.
package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
)

// keysProbeRequest is the Save & Test body.
//
// Service selects which of the daemon's providers to test ("groq" or
// "gemini"). Key is the credential to prove; empty re-tests the key the
// daemon itself is configured with.
type keysProbeRequest struct {
	Service string `json:"service"`
	Key     string `json:"key"`
}

// handleKeysProbe answers "does this API key still work?" for one provider.
//
// The same rule as every other handler here: guard the dependency that will
// actually be dereferenced, not the config flag. The probe outcome is logged
// with `"ok"` — the key itself never appears in any log or response.
func (s *Server) handleKeysProbe(w http.ResponseWriter, r *http.Request) {
	var req keysProbeRequest
	if !decodeJSON(w, r, &req) {
		return
	}

	service := strings.ToLower(strings.TrimSpace(req.Service))

	var res cloud.ProbeResult
	switch service {
	case "groq":
		if s.groqClient() == nil {
			res = cloud.ProbeResult{
				OK:     false,
				Detail: "no Groq key is configured on this daemon (set GROQ_API_KEY in .env)",
			}
		} else {
			res = s.groqClient().Probe(r.Context(), req.Key)
		}
	case "gemini":
		if s.geminiClient() == nil {
			res = cloud.ProbeResult{
				OK:     false,
				Detail: "no Gemini key is configured on this daemon (set GEMINI_API_KEY in .env)",
			}
		} else {
			res = s.geminiClient().Probe(r.Context(), req.Key)
		}
	case "elevenlabs":
		// A probe proves the key under test, not the pool — so a bare client
		// works even when no account is configured yet. This is the exact
		// call the add-flow runs first.
		eleven := s.elevenClient()
		if eleven == nil {
			eleven = cloud.NewEleven(nil, "", "", "")
		}
		probe := eleven.Probe(r.Context(), req.Key)
		res = probe.ProbeResult
		if probe.OK && probe.Tier != "" {
			quota := fmt.Sprintf(" (%s account, quota %d/%d)", probe.Tier, probe.QuotaUsed, probe.QuotaLimit)
			if probe.QuotaLimit <= 0 {
				quota = " (" + probe.Tier + " account)"
			}
			res.Detail = strings.TrimSuffix(res.Detail, " account") + quota
		}
	case "":
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "service is required: \"groq\", \"gemini\" or \"elevenlabs\"",
		})
		return
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unknown service " + req.Service + ", use \"groq\", \"gemini\" or \"elevenlabs\"",
		})
		return
	}

	s.deps.Log.Info("key probe", "service", service, "ok", res.OK)
	writeJSON(w, http.StatusOK, res)
}
