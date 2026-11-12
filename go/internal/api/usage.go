// Package api — usage.go: GET /v1/usage, the numbers behind the gauge.
//
// The response is whatever cloud.UsageRecorder has actually observed — calls,
// tokens, latency percentiles, the last error, and Groq's rate-limit headers
// copied verbatim. It is a plain 200 even when nothing has been recorded yet:
// "no calls yet" is a state the UI can draw (an empty ring), while an error
// would make a healthy daemon look broken.
//
// Gemini deliberately arrives here with rate_limit null. Google's API key
// endpoints send no quota headers, and inventing a fill percentage from our
// own counters would be a guess dressed as a measurement — so the handler
// leaves it absent and the card says the limit is published elsewhere.
package api

import (
	"net/http"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/config"
)

// handleUsage reports the recorder's snapshot plus what is configured, so the
// UI renders one payload instead of racing two requests.
func (s *Server) handleUsage(w http.ResponseWriter, _ *http.Request) {
	var snap cloud.UsageSnapshot
	if s.deps.Usage != nil {
		snap = s.deps.Usage.Snapshot()
	} else {
		snap = cloud.UsageSnapshot{
			Services: map[string]cloud.ServiceUsage{},
			Recent:   []cloud.CallSummary{},
		}
	}

	var callsPath string
	if s.deps.Usage != nil {
		callsPath = s.deps.Usage.CallsPath()
	}
	writeJSON(w, http.StatusOK, usageResponse{
		UsageSnapshot: snap,
		Keys:          s.keyStates(),
		OverlayPath:   config.KeysPath(s.deps.EnvPath),
		CallsPath:     callsPath,
	})
}

// usageResponse is GET /v1/usage's payload.
type usageResponse struct {
	cloud.UsageSnapshot
	Keys        []keyState `json:"keys"`
	OverlayPath string     `json:"overlay_path,omitempty"`
	CallsPath   string     `json:"calls_path,omitempty"`
}
