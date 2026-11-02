package cloud

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ── rate-limit headers ──────────────────────────────────────────────────

func TestParseRateLimitCopiesTheRealHeaders(t *testing.T) {
	// The headers exactly as api.groq.com sent them while this file was
	// written: limit-requests is requests PER DAY, limit-tokens is tokens PER
	// MINUTE — misreading either is how a gauge lies.
	h := http.Header{}
	h.Set("x-ratelimit-limit-requests", "1000")
	h.Set("x-ratelimit-remaining-requests", "400")
	h.Set("x-ratelimit-reset-requests", "1m26.4s")
	h.Set("x-ratelimit-limit-tokens", "8000")
	h.Set("x-ratelimit-remaining-tokens", "7927")
	h.Set("x-ratelimit-reset-tokens", "547ms")

	rl := ParseRateLimit(h)
	if rl == nil {
		t.Fatal("headers present, snapshot must not be nil")
	}
	if rl.RequestsLimit != 1000 || rl.RequestsRemaining != 400 {
		t.Errorf("requests = %d/%d, want 1000/400", rl.RequestsRemaining, rl.RequestsLimit)
	}
	if rl.TokensLimit != 8000 || rl.TokensRemaining != 7927 {
		t.Errorf("tokens = %d/%d, want 8000/7927", rl.TokensRemaining, rl.TokensLimit)
	}
	if rl.RequestsReset != "1m26.4s" || rl.TokensReset != "547ms" {
		t.Errorf("resets = %q/%q, want the raw strings", rl.RequestsReset, rl.TokensReset)
	}
	if got := rl.RequestsUsedPercent(); got != 60 {
		t.Errorf("requests used = %d%%, want 60%%", got)
	}
	if got := rl.TokensUsedPercent(); got != 1 {
		t.Errorf("tokens used = %d%%, want 1%% (73 of 8000 rounds up so it is visible)", got)
	}
	// 1 of 1000 must not truncate to 0: that would make the first ten calls
	// of a day invisible on the ring.
	one := &RateLimit{RequestsLimit: 1000, RequestsRemaining: 999}
	if got := one.RequestsUsedPercent(); got != 1 {
		t.Errorf("1 of 1000 used = %d%%, want 1%%", got)
	}
	zero := &RateLimit{RequestsLimit: 1000, RequestsRemaining: 1000}
	if got := zero.RequestsUsedPercent(); got != 0 {
		t.Errorf("nothing used = %d%%, want exactly 0%%", got)
	}
}

func TestRateLimitUnknownIsNotZero(t *testing.T) {
	// Gemini's API sends no quota headers. -1 (not 0) is what keeps the UI
	// from drawing a confident empty ring for an unmeasured limit.
	if got := (*RateLimit)(nil).RequestsUsedPercent(); got != -1 {
		t.Errorf("nil receiver = %d%%, want -1", got)
	}
	if got := (*RateLimit)(nil).TokensUsedPercent(); got != -1 {
		t.Errorf("nil receiver = %d%%, want -1", got)
	}

	if ParseRateLimit(http.Header{}) != nil {
		t.Error("a response with no rate-limit headers must record no snapshot")
	}

	full := &RateLimit{RequestsLimit: 0, RequestsRemaining: 0}
	if got := full.RequestsUsedPercent(); got != -1 {
		t.Errorf("a zero limit is unknown, got %d%%", got)
	}
	empty := &RateLimit{RequestsLimit: 100, RequestsRemaining: 0}
	if got := empty.RequestsUsedPercent(); got != 100 {
		t.Errorf("0 of 100 remaining = %d%%, want 100%%", got)
	}
	over := &RateLimit{RequestsLimit: 100, RequestsRemaining: 250}
	if got := over.RequestsUsedPercent(); got != 0 {
		t.Errorf("more remaining than the limit is nonsense, clamp to 0 not %d%%", got)
	}
}

// ── the transport ───────────────────────────────────────────────────────

// stubProvider answers with a Groq-shaped reply: rate-limit headers, a usage
// block, and a body long enough that a naive "read it and drop it" transport
// would break the caller.
func stubProvider(t *testing.T) *httptest.Server {
	t.Helper()

	body, err := json.Marshal(map[string]any{
		"id": "chatcmpl-1",
		"usage": map[string]any{
			"prompt_tokens":     72,
			"completion_tokens": 30,
			"total_tokens":      102,
		},
		"padding": strings.Repeat("x", 4096),
	})
	if err != nil {
		t.Fatalf("marshal stub body: %v", err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		h := w.Header()
		h.Set("Content-Type", "application/json")
		h.Set("x-ratelimit-limit-requests", "1000")
		h.Set("x-ratelimit-remaining-requests", "999")
		h.Set("x-ratelimit-limit-tokens", "8000")
		h.Set("x-ratelimit-remaining-tokens", "7927")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestTransportRecordsTokensAndLeavesBodyIntact(t *testing.T) {
	srv := stubProvider(t)
	rec := NewUsageRecorder("") // memory-only: no file in this test

	hc := &http.Client{Timeout: 5 * time.Second}
	WithUsage(hc, "groq", rec)

	resp, err := hc.Post(srv.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	// The caller must still get every byte: peeking at the usage block is an
	// observation, not a consumption.
	got, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var echo struct {
		Usage struct {
			PromptTokens int `json:"prompt_tokens"`
		} `json:"usage"`
		Padding string `json:"padding"`
	}
	if err := json.Unmarshal(got, &echo); err != nil {
		t.Fatalf("response body was altered: %v", err)
	}
	if echo.Usage.PromptTokens != 72 {
		t.Errorf("prompt tokens = %d, want 72", echo.Usage.PromptTokens)
	}
	if len(echo.Padding) != 4096 {
		t.Errorf("padding lost: %d bytes, want 4096", len(echo.Padding))
	}

	snap := rec.Snapshot()
	u, ok := snap.Services["groq"]
	if !ok {
		t.Fatalf("groq not recorded; services = %+v", snap.Services)
	}
	if u.Calls != 1 || u.Errors != 0 {
		t.Errorf("calls/errors = %d/%d, want 1/0", u.Calls, u.Errors)
	}
	if u.TokensIn != 72 || u.TokensOut != 30 {
		t.Errorf("tokens = %d in / %d out, want 72/30", u.TokensIn, u.TokensOut)
	}
	if u.RateLimit == nil || u.RequestsUsedPC != 1 {
		t.Errorf("rate limit missing or wrong: %+v (used=%d%%, want 1%% for 1 of 1000)", u.RateLimit, u.RequestsUsedPC)
	}
	if len(snap.Recent) != 1 || snap.Recent[0].TokensIn != 72 {
		t.Errorf("recent call list wrong: %+v", snap.Recent)
	}
}

func TestTransportCountsErrorsAnd429s(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("x-ratelimit-limit-requests", "1000")
		w.Header().Set("x-ratelimit-remaining-requests", "0")
		w.Header().Set("retry-after", "2")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}))
	t.Cleanup(srv.Close)

	rec := NewUsageRecorder("")
	hc := &http.Client{Timeout: 5 * time.Second}
	WithUsage(hc, "groq", rec)

	resp, err := hc.Post(srv.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	resp.Body.Close()

	u := rec.Snapshot().Services["groq"]
	if u.Calls != 1 || u.Errors != 1 || u.RateLimited != 1 {
		t.Errorf("calls/errors/429 = %d/%d/%d, want 1/1/1", u.Calls, u.Errors, u.RateLimited)
	}
	if u.RateLimit == nil || u.RateLimit.RetryAfter != "2" {
		t.Errorf("retry-after not captured: %+v", u.RateLimit)
	}
	if u.RequestsUsedPC != 100 {
		t.Errorf("used = %d%%, want 100%%", u.RequestsUsedPC)
	}
	if u.LastError == "" {
		t.Error("last_error should say what went wrong")
	}
}

func TestTransportIgnoresNonJSONBodies(t *testing.T) {
	// An SSE stream or a binary reply must stream through untouched: buffering
	// it would be exactly the memory spike the package forbids.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"x\":1}\n\n"))
	}))
	t.Cleanup(srv.Close)

	rec := NewUsageRecorder("")
	hc := &http.Client{Timeout: 5 * time.Second}
	WithUsage(hc, "groq", rec)

	resp, err := hc.Post(srv.URL, "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	if body, _ := io.ReadAll(resp.Body); !strings.Contains(string(body), "data:") {
		t.Errorf("stream body altered: %q", body)
	}
	u := rec.Snapshot().Services["groq"]
	if u.TokensIn != 0 || u.TokensOut != 0 {
		t.Errorf("a stream cannot be token-counted here, got %d/%d", u.TokensIn, u.TokensOut)
	}
	if u.Calls != 1 {
		t.Errorf("the call itself must still be counted, got %d", u.Calls)
	}
}

func TestWithUsageIsANoOpAndNeverDoubleWraps(t *testing.T) {
	// nil args must not panic; reaching here is the assertion.
	WithUsage(nil, "groq", nil)

	rec := NewUsageRecorder("")
	hc := &http.Client{}
	WithUsage(hc, "groq", rec)
	WithUsage(hc, "groq", rec) // a second wrap would count every call twice

	if _, ok := hc.Transport.(*UsageTransport); !ok {
		t.Fatalf("transport = %T, want *UsageTransport", hc.Transport)
	}
}

// ── counts, percentiles, persistence ────────────────────────────────────

func TestLatencyStats(t *testing.T) {
	// 1..100 ms: p50 must be above the halfway sample (ceiling, not rounding
	// down to "no sample"), p95 near the top, max exact.
	samples := make([]int64, 100)
	for i := range samples {
		samples[i] = int64(i + 1)
	}
	avg, p50, p95, max := latencyStats(samples)

	if avg != 50 {
		t.Errorf("avg = %d, want 50", avg)
	}
	if p50 < 50 || p50 > 51 {
		t.Errorf("p50 = %d, want 50 or 51", p50)
	}
	if p95 < 95 {
		t.Errorf("p95 = %d, want >= 95", p95)
	}
	if max != 100 {
		t.Errorf("max = %d, want 100", max)
	}

	if a, b, c, d := latencyStats(nil); a != 0 || b != 0 || c != 0 || d != 0 {
		t.Errorf("empty samples must report zeros, got %d/%d/%d/%d", a, b, c, d)
	}
}

func TestUsageCountersSurviveARestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api-usage.json")

	rec := NewUsageRecorder(path)
	rec.Record(Call{Service: "groq", Status: 200, LatencyMS: 42, TokensIn: 10, TokensOut: 5,
		RateLimit: &RateLimit{RequestsLimit: 1000, RequestsRemaining: 900},
		At:        time.Now()})
	rec.Flush()

	reloaded := NewUsageRecorder(path)
	snap := reloaded.Snapshot()
	u, ok := snap.Services["groq"]
	if !ok {
		t.Fatalf("no groq counters after reload: %+v", snap.Services)
	}
	if u.Calls != 1 || u.TokensIn != 10 || u.TokensOut != 5 {
		t.Errorf("reloaded counters = %+v, want calls=1 tokens=10/5", u)
	}
	if u.RateLimit == nil || u.RateLimit.RequestsRemaining != 900 {
		t.Errorf("rate-limit snapshot lost: %+v", u.RateLimit)
	}
	if u.LastCall == nil {
		t.Error("last call time lost")
	}
}

func TestCorruptUsageFileStartsFresh(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api-usage.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	rec := NewUsageRecorder(path) // must not panic or error out
	rec.Record(Call{Service: "gemini", Status: 200, LatencyMS: 5})
	if got := rec.Snapshot().Services["gemini"].Calls; got != 1 {
		t.Errorf("calls = %d, want 1", got)
	}
}

func TestDayBucketRollsOverMidnight(t *testing.T) {
	rec := NewUsageRecorder("")
	yesterday := time.Date(2026, 10, 31, 23, 59, 0, 0, time.Local)
	today := time.Date(2026, 11, 1, 0, 1, 0, 0, time.Local)

	rec.Record(Call{Service: "groq", At: yesterday})
	rec.Record(Call{Service: "groq", At: today})

	u := rec.Snapshot().Services["groq"]
	if u.Calls != 2 {
		t.Errorf("lifetime calls = %d, want 2", u.Calls)
	}
	if u.Today == nil || u.Today.Date != "2026-11-01" || u.Today.Calls != 1 {
		t.Errorf("today bucket = %+v, want 2026-11-01 with 1 call", u.Today)
	}
}
