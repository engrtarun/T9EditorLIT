// Package cloud — probe.go: does this key still work?
//
// The Save & Test button on the setup page must never answer "connected"
// just because a key field is non-empty. This file holds the two cheapest
// real calls that prove a credential: both list the account's models, which
// is a GET that costs no tokens and no quota worth counting, and both answer
// 401/403 for a key Google or Groq has rejected.
//
// The key under test travels in the request body from the desktop app and is
// used for this one call — it is never logged, never stored here, and never
// echoed back. The daemon's own configured key can be probed too (empty
// request), which is how the UI re-verifies a saved credential after a
// daemon restart.
package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// ProbeResult is what the UI renders. Detail is a human sentence, safe to
// show — it never contains the key.
type ProbeResult struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// modelsResponse is only decoded far enough to tell "answered" from "gibberish".
type modelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// maxProbeBody caps how much of a models list we are willing to read. The
// real lists are tens of kilobytes; a hostile or broken endpoint should not
// be able to make the daemon buffer more than that.
const maxProbeBody = 1 << 20 // 1 MiB

// httpStatusError turns a non-2xx into the sentence the card will show.
//
// 401 and 403 mean the provider rejected the key itself — the one answer the
// user can act on by pasting a different key. Everything else is reported as
// a connectivity or provider problem, so a flaky network never masquerades
// as "your key is wrong".
func httpStatusError(service string, status int, body []byte) error {
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return fmt.Errorf("%s rejected this API key (%d) — check the key and try again", service, status)
	case status == http.StatusTooManyRequests:
		return fmt.Errorf("%s rate-limited the test (%d) — wait a moment and retry", service, status)
	case status >= 500:
		return fmt.Errorf("%s had a server problem (%d) — not a key problem, retry later", service, status)
	default:
		snippet := strings.TrimSpace(string(body))
		if len(snippet) > 160 {
			snippet = snippet[:160] + "…"
		}
		if snippet == "" {
			snippet = "empty response"
		}
		return fmt.Errorf("%s answered %d: %s", service, status, snippet)
	}
}

// Probe reports whether the given Groq key is live by listing the account's
// models. An empty key falls back to the client's own configured key, which
// is how the daemon re-verifies what it was started with.
//
// The probe gets its own short-deadline client when the caller passes one
// with a long timeout: a key check should fail in seconds, not after the
// three minutes a Whisper upload is allowed.
func (c *GroqClient) Probe(ctx context.Context, key string) ProbeResult {
	if key == "" {
		key = c.APIKey
	}
	if key == "" {
		return ProbeResult{OK: false, Detail: "no Groq API key yet — paste one above"}
	}

	// The models list hangs off the same host as the transcribe URL, so an
	// httptest override in tests follows along automatically. A custom
	// endpoint without the transcribe path — a proxy or a test stub — is
	// honoured as given: stripping a suffix that is not there must never
	// redirect the probe to the public host. Before this was fixed, a stub
	// URL lost its override and the real api.groq.com answered an accidental
	// 401 for an otherwise valid test key.
	base := c.URL
	if trimmed := strings.TrimSuffix(base, "/audio/transcriptions"); trimmed != base {
		base = trimmed
	}
	base = strings.TrimSuffix(base, "/")

	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return ProbeResult{OK: false, Detail: "could not build the test request: " + err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+key)

	res, err := c.HTTP.Do(req)
	if err != nil {
		return ProbeResult{OK: false, Detail: "could not reach api.groq.com: " + err.Error()}
	}
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxProbeBody))
	if err != nil {
		return ProbeResult{OK: false, Detail: "the test response was cut short: " + err.Error()}
	}
	if res.StatusCode != http.StatusOK {
		return ProbeResult{OK: false, Detail: httpStatusError("Groq", res.StatusCode, body).Error()}
	}

	var parsed modelsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ProbeResult{OK: false, Detail: "Groq sent an unreadable answer: " + err.Error()}
	}
	return ProbeResult{OK: true, Detail: "key works — " + modelCount(len(parsed.Data))}
}

// Probe reports whether the given Gemini key is live by listing the
// account's models. An empty key falls back to the client's own key.
func (c *GeminiClient) Probe(ctx context.Context, key string) ProbeResult {
	if key == "" {
		key = c.APIKey
	}
	if key == "" {
		return ProbeResult{OK: false, Detail: "no Gemini API key yet — paste one above"}
	}

	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"?key="+key, nil)
	if err != nil {
		return ProbeResult{OK: false, Detail: "could not build the test request: " + err.Error()}
	}

	res, err := c.HTTP.Do(req)
	if err != nil {
		return ProbeResult{OK: false, Detail: "could not reach generativelanguage.googleapis.com: " + err.Error()}
	}
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxProbeBody))
	if err != nil {
		return ProbeResult{OK: false, Detail: "the test response was cut short: " + err.Error()}
	}
	if res.StatusCode != http.StatusOK {
		return ProbeResult{OK: false, Detail: httpStatusError("Gemini", res.StatusCode, body).Error()}
	}

	var parsed modelsResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ProbeResult{OK: false, Detail: "Gemini sent an unreadable answer: " + err.Error()}
	}
	return ProbeResult{OK: true, Detail: "key works — " + modelCount(len(parsed.Data))}
}

// modelCount phrases the model tally without lying about precision: an
// endpoint that stops paginating still proved the key, so the count is
// reported as at-least.
func modelCount(n int) string {
	switch {
	case n == 0:
		return "account answered"
	case n < 5:
		return fmt.Sprintf("%d models visible", n)
	default:
		return fmt.Sprintf("%d+ models visible", n)
	}
}
