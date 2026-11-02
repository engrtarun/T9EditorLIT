// Package cloud — usage.go: what the providers actually answered, on disk.
//
// The app can only show a limit gauge if something observed it. This file is
// the one seam that does: a RoundTripper wrapped around the Groq and Gemini
// clients, recording every call the daemon makes — latency, status, token
// counts, and the x-ratelimit-* headers Groq sends back with each inference.
//
// Two rules kept here, because they are what makes the numbers trustworthy:
//
//   - **Nothing is invented.** Gemini's API sends no rate-limit headers at
//     all, so Gemini's rate_limit stays null and the UI must say "not
//     published" instead of drawing a ring from a guess. Groq's numbers are
//     copied verbatim from the headers, including their documented meaning:
//     x-ratelimit-limit-requests is requests PER DAY and
//     x-ratelimit-limit-tokens is tokens PER MINUTE.
//   - **The response body is never lost.** Reading the token counts means
//     reading JSON, so the body is buffered, parsed, and handed back through
//     an io.MultiReader — the caller sees exactly the bytes it would have
//     seen, and no media is ever involved (these are provider JSON replies,
//     a few kilobytes each).
package cloud

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RateLimit is one provider's rate-limit answer, copied from response headers.
//
// The Go zero value of an int field means "this header was absent", which is
// the honest reading for a provider that does not send it — JSON omitempty
// keeps those out of the payload so the UI can tell "0 remaining" (true) from
// "unknown" (absent).
type RateLimit struct {
	// RequestsLimit/Remaining/Reset describe requests PER DAY on Groq.
	RequestsLimit     int    `json:"requests_limit,omitempty"`
	RequestsRemaining int    `json:"requests_remaining"`
	RequestsReset     string `json:"requests_reset,omitempty"`
	// TokensLimit/Remaining/Reset describe tokens PER MINUTE on Groq.
	TokensLimit     int    `json:"tokens_limit,omitempty"`
	TokensRemaining int    `json:"tokens_remaining"`
	TokensReset     string `json:"tokens_reset,omitempty"`
	// RetryAfter only exists on a 429, which is exactly when a UI needs it.
	RetryAfter string    `json:"retry_after,omitempty"`
	CapturedAt time.Time `json:"captured_at,omitempty"`
}

// RequestsUsedPercent is how full the daily request bucket is.
//
// It returns -1 when the provider sent no request limit (Gemini, and any
// Groq endpoint that does not meter), because a gauge that fills from an
// unknown denominator is worse than one that stays empty. -1 is deliberately
// outside 0..100 so a UI can never mistake "unknown" for "empty".
func (r *RateLimit) RequestsUsedPercent() int {
	// The nil check has to live here, not only in usedPercent: reading
	// r.RequestsLimit for the call would panic before the guard runs.
	if r == nil {
		return -1
	}
	return r.usedPercent(r.RequestsLimit, r.RequestsRemaining)
}

// TokensUsedPercent is how full the per-minute token bucket is.
func (r *RateLimit) TokensUsedPercent() int {
	if r == nil {
		return -1
	}
	return r.usedPercent(r.TokensLimit, r.TokensRemaining)
}

// usedPercent answers for a nil receiver too: a provider that never said is
// "unknown", never "0%".
//
// The division rounds **up**, not down. At 1,000 requests per day one call is
// 0.1%, and truncating that to 0% would make the first ten calls of a day
// invisible on the ring — the user would see a gauge that never moves and
// conclude it is broken. Ceiling means "the ring moved" always means "at
// least one call was made", while 0 remains exactly 0.
func (r *RateLimit) usedPercent(limit, remaining int) int {
	if r == nil || limit <= 0 {
		return -1
	}
	if remaining < 0 {
		remaining = 0
	}
	if remaining > limit {
		remaining = limit
	}
	used := (limit - remaining) * 100
	return clampPercent((used + limit - 1) / limit)
}

func clampPercent(p int) int {
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}

// ParseRateLimit reads the x-ratelimit-* headers. It returns nil when the
// response carried none, which is how a Gemini reply (or a Groq /models
// listing, which is not metered) is recorded as "unknown" rather than "zero".
func ParseRateLimit(h http.Header) *RateLimit {
	if h == nil {
		return nil
	}
	limitReq := strings.TrimSpace(h.Get("x-ratelimit-limit-requests"))
	limitTok := strings.TrimSpace(h.Get("x-ratelimit-limit-tokens"))
	if limitReq == "" && limitTok == "" {
		return nil
	}
	return &RateLimit{
		RequestsLimit:     atoi(limitReq),
		RequestsRemaining: atoi(h.Get("x-ratelimit-remaining-requests")),
		RequestsReset:     strings.TrimSpace(h.Get("x-ratelimit-reset-requests")),
		TokensLimit:       atoi(limitTok),
		TokensRemaining:   atoi(h.Get("x-ratelimit-remaining-tokens")),
		TokensReset:       strings.TrimSpace(h.Get("x-ratelimit-reset-tokens")),
		RetryAfter:        strings.TrimSpace(h.Get("retry-after")),
		CapturedAt:        time.Now().UTC(),
	}
}

func atoi(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 {
		return 0
	}
	return n
}

// ── the recorder ────────────────────────────────────────────────────────

// Call is one observed provider request. The transport builds it; the
// recorder folds it into the running totals.
type Call struct {
	Service   string
	Status    int
	LatencyMS int64
	TokensIn  int
	TokensOut int
	RateLimit *RateLimit
	Err       string
	At        time.Time
}

// dayUsage is the "since midnight" bucket behind the slow-moving part of the
// gauge. It is kept beside the lifetime totals so the UI never has to do
// date arithmetic over a log it does not have.
type dayUsage struct {
	Date       string `json:"date"`
	Calls      int64  `json:"calls"`
	TokensIn   int64  `json:"tokens_in"`
	TokensOut  int64  `json:"tokens_out"`
	LastStatus int    `json:"last_status,omitempty"`
}

// serviceUsage is one provider's running totals.
type serviceUsage struct {
	Calls         int64
	Errors        int64
	RateLimited   int64
	TokensIn      int64
	TokensOut     int64
	Latencies     []int64 // ms, most recent last, capped
	LastCall      time.Time
	LastLatencyMS int64
	LastError     string
	LastErrorAt   time.Time
	RateLimit     *RateLimit
	Today         *dayUsage
}

// ServiceUsage is the JSON shape of one provider's numbers.
//
// Latency percentiles are computed from the recorded samples rather than
// stored, so a stale file cannot disagree with its own history.
type ServiceUsage struct {
	Service        string     `json:"service"`
	Calls          int64      `json:"calls"`
	Errors         int64      `json:"errors"`
	RateLimited    int64      `json:"rate_limited"`
	TokensIn       int64      `json:"tokens_in"`
	TokensOut      int64      `json:"tokens_out"`
	LastCall       *time.Time `json:"last_call,omitempty"`
	LastLatencyMS  int64      `json:"last_latency_ms"`
	AvgLatencyMS   int64      `json:"avg_latency_ms"`
	P50LatencyMS   int64      `json:"p50_latency_ms"`
	P95LatencyMS   int64      `json:"p95_latency_ms"`
	MaxLatencyMS   int64      `json:"max_latency_ms"`
	LastError      string     `json:"last_error,omitempty"`
	LastErrorAt    *time.Time `json:"last_error_at,omitempty"`
	RateLimit      *RateLimit `json:"rate_limit,omitempty"`
	Today          *dayUsage  `json:"today,omitempty"`
	RequestsUsedPC int        `json:"requests_used_pct"` // -1 = unknown
	TokensUsedPC   int        `json:"tokens_used_pct"`   // -1 = unknown
}

// UsageSnapshot is the whole GET /v1/usage payload.
type UsageSnapshot struct {
	UpdatedAt time.Time               `json:"updated_at"`
	Services  map[string]ServiceUsage `json:"services"`
	Recent    []CallSummary           `json:"recent"`
}

// CallSummary is one line of the recent-calls list. Keys and prompts are never
// recorded — only what the call cost.
type CallSummary struct {
	Service   string    `json:"service"`
	At        time.Time `json:"at"`
	Status    int       `json:"status"`
	LatencyMS int64     `json:"latency_ms"`
	TokensIn  int       `json:"tokens_in"`
	TokensOut int       `json:"tokens_out"`
	Err       string    `json:"err,omitempty"`
}

const (
	maxLatencySamples = 256
	maxRecentCalls    = 40
	// maxUsagePeek bounds how much of a provider reply may be buffered to read
	// its token counts. Larger replies stream through untouched: the caller
	// still gets every byte, we just record zero tokens for them.
	maxUsagePeek = 2 << 20
	// saveThrottle keeps a burst of chat calls from turning every record into
	// a disk write on a machine with ~1 GB free.
	saveThrottle = 2 * time.Second
)

// UsageRecorder accumulates provider calls and keeps them on disk.
//
// The zero value is not usable; call NewUsageRecorder. An empty path makes the
// recorder memory-only, which is what tests and a daemon without a writable
// directory get.
type UsageRecorder struct {
	mu       sync.Mutex
	path     string
	services map[string]*serviceUsage
	recent   []CallSummary
	dirty    bool
	lastSave time.Time
}

// NewUsageRecorder builds a recorder and loads any counters left by a previous
// run. A missing or unreadable file is not an error — the daemon must start.
func NewUsageRecorder(path string) *UsageRecorder {
	rec := &UsageRecorder{
		path:     path,
		services: map[string]*serviceUsage{},
		recent:   []CallSummary{},
	}
	rec.load()
	return rec
}

func (r *UsageRecorder) svc(service string) *serviceUsage {
	s, ok := r.services[service]
	if !ok {
		s = &serviceUsage{}
		r.services[service] = s
	}
	return s
}

// Record folds one call into the totals. It is safe to call from any
// goroutine, and it never blocks on disk for longer than a small write.
func (r *UsageRecorder) Record(c Call) {
	if r == nil {
		return
	}
	if c.At.IsZero() {
		c.At = time.Now()
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	s := r.svc(c.Service)
	s.Calls++
	s.TokensIn += int64(c.TokensIn)
	s.TokensOut += int64(c.TokensOut)
	s.LastCall = c.At
	s.LastLatencyMS = c.LatencyMS

	s.Latencies = append(s.Latencies, c.LatencyMS)
	if len(s.Latencies) > maxLatencySamples {
		// Drop the oldest half rather than one: a rolling slice every call
		// would make this O(n) on the hot path for no benefit.
		copy(s.Latencies, s.Latencies[len(s.Latencies)/2:])
		s.Latencies = s.Latencies[:len(s.Latencies)/2]
	}

	if c.Status >= 400 || c.Err != "" {
		s.Errors++
		s.LastError = firstNonEmpty(c.Err, "HTTP "+strconv.Itoa(c.Status))
		s.LastErrorAt = c.At
	}
	if c.Status == http.StatusTooManyRequests {
		s.RateLimited++
	}
	if c.RateLimit != nil {
		s.RateLimit = c.RateLimit
	}

	// The day bucket drives the slow-moving ring: it resets at local midnight
	// so "filling up" means something a person can watch across a working day.
	today := c.At.Local().Format("2006-01-02")
	if s.Today == nil || s.Today.Date != today {
		s.Today = &dayUsage{Date: today}
	}
	s.Today.Calls++
	s.Today.TokensIn += int64(c.TokensIn)
	s.Today.TokensOut += int64(c.TokensOut)
	s.Today.LastStatus = c.Status

	r.recent = append(r.recent, CallSummary{
		Service: c.Service, At: c.At, Status: c.Status,
		LatencyMS: c.LatencyMS, TokensIn: c.TokensIn, TokensOut: c.TokensOut,
		Err: func() string {
			if c.Status >= 400 || c.Err != "" {
				return firstNonEmpty(c.Err, "HTTP "+strconv.Itoa(c.Status))
			}
			return ""
		}(),
	})
	if len(r.recent) > maxRecentCalls {
		r.recent = r.recent[len(r.recent)-maxRecentCalls:]
	}

	r.dirty = true
	r.saveLocked(false)
}

// Flush writes anything the throttle is holding back. Call it on shutdown.
func (r *UsageRecorder) Flush() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.saveLocked(true)
}

// Snapshot returns the whole picture for GET /v1/usage.
func (r *UsageRecorder) Snapshot() UsageSnapshot {
	if r == nil {
		return UsageSnapshot{UpdatedAt: time.Now().UTC(), Services: map[string]ServiceUsage{}, Recent: []CallSummary{}}
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	out := UsageSnapshot{
		UpdatedAt: time.Now().UTC(),
		Services:  make(map[string]ServiceUsage, len(r.services)),
		Recent:    append([]CallSummary(nil), r.recent...),
	}
	if out.Recent == nil {
		out.Recent = []CallSummary{}
	}
	for name, s := range r.services {
		u := ServiceUsage{
			Service:        name,
			Calls:          s.Calls,
			Errors:         s.Errors,
			RateLimited:    s.RateLimited,
			TokensIn:       s.TokensIn,
			TokensOut:      s.TokensOut,
			LastLatencyMS:  s.LastLatencyMS,
			LastError:      s.LastError,
			RateLimit:      s.RateLimit,
			Today:          s.Today,
			RequestsUsedPC: s.RateLimit.RequestsUsedPercent(),
			TokensUsedPC:   s.RateLimit.TokensUsedPercent(),
		}
		if !s.LastCall.IsZero() {
			t := s.LastCall.UTC()
			u.LastCall = &t
		}
		if !s.LastErrorAt.IsZero() {
			t := s.LastErrorAt.UTC()
			u.LastErrorAt = &t
		}
		u.AvgLatencyMS, u.P50LatencyMS, u.P95LatencyMS, u.MaxLatencyMS = latencyStats(s.Latencies)
		out.Services[name] = u
	}
	return out
}

// latencyStats computes the numbers the UI shows, from the recorded samples.
// An empty sample set reports zeros rather than NaN.
func latencyStats(samples []int64) (avg, p50, p95, max int64) {
	if len(samples) == 0 {
		return 0, 0, 0, 0
	}
	sorted := append([]int64(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })

	var total int64
	for _, v := range sorted {
		total += v
		if v > max {
			max = v
		}
	}
	avg = total / int64(len(sorted))
	p50 = percentile(sorted, 0.50)
	p95 = percentile(sorted, 0.95)
	return avg, p50, p95, max
}

func percentile(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return 0
	}
	idx := int(p*float64(len(sorted))+0.999) - 1 // ceiling: never "no sample"
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return sorted[idx]
}

// ── persistence ─────────────────────────────────────────────────────────

type usageFile struct {
	Version  int                      `json:"version"`
	Services map[string]*serviceUsage `json:"services"`
	Recent   []CallSummary            `json:"recent"`
}

func (r *UsageRecorder) load() {
	if r.path == "" {
		return
	}
	data, err := os.ReadFile(r.path)
	if err != nil {
		return // first run, or a directory we may not read: start at zero
	}
	var f usageFile
	if err := json.Unmarshal(data, &f); err != nil {
		return // a corrupt counters file must never stop the daemon
	}
	for name, s := range f.Services {
		if s != nil {
			r.services[name] = s
		}
	}
	if len(f.Recent) > 0 {
		if len(f.Recent) > maxRecentCalls {
			f.Recent = f.Recent[len(f.Recent)-maxRecentCalls:]
		}
		r.recent = f.Recent
	}
}

// saveLocked writes the file when the throttle allows. Caller holds r.mu.
func (r *UsageRecorder) saveLocked(force bool) {
	if !r.dirty || r.path == "" {
		return
	}
	now := time.Now()
	if !force && now.Sub(r.lastSave) < saveThrottle {
		return
	}

	data, err := json.Marshal(usageFile{
		Version:  1,
		Services: r.services,
		Recent:   r.recent,
	})
	if err != nil {
		return
	}

	// Write-then-rename: a half-written file can never be what the next
	// daemon start reads, even if this one is killed mid-write.
	dir := filepath.Dir(r.path)
	tmp, err := os.CreateTemp(dir, ".api-usage-*")
	if err != nil {
		return
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return
	}
	if err := os.Rename(tmp.Name(), r.path); err != nil {
		os.Remove(tmp.Name())
		return
	}
	r.dirty = false
	r.lastSave = now
}

// ── the transport ───────────────────────────────────────────────────────

// UsageTransport records every request that passes through it.
//
// It sits under the client's own http.Client, so timeouts, retries above it,
// and the streaming multipart upload are all untouched: only the observation
// is added.
type UsageTransport struct {
	Base    http.RoundTripper
	Service string
	Rec     *UsageRecorder
}

// WithUsage wires a recorder into an HTTP client's transport. It is a no-op
// when either argument is nil, so tests that build a client without counters
// keep working.
func WithUsage(hc *http.Client, service string, rec *UsageRecorder) {
	if hc == nil || rec == nil {
		return
	}
	base := hc.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	// Never double-wrap: a second daemon start over the same client would
	// otherwise record every call twice.
	if _, ok := base.(*UsageTransport); ok {
		return
	}
	hc.Transport = &UsageTransport{Base: base, Service: service, Rec: rec}
}

func (t *UsageTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	base := t.Base
	if base == nil {
		base = http.DefaultTransport
	}
	if t.Rec == nil || t.Service == "" {
		return base.RoundTrip(req)
	}

	start := time.Now()
	resp, err := base.RoundTrip(req)

	call := Call{
		Service:   t.Service,
		At:        start,
		LatencyMS: time.Since(start).Milliseconds(),
	}
	if err != nil {
		call.Err = err.Error()
	}
	if resp != nil {
		call.Status = resp.StatusCode
		call.RateLimit = ParseRateLimit(resp.Header)
		if in, out := peekTokens(resp, t.Service); in > 0 || out > 0 {
			call.TokensIn, call.TokensOut = in, out
		}
	}

	t.Rec.Record(call)
	return resp, err
}

// peekTokens reads the token counts out of a provider JSON reply and puts the
// body back exactly as it was.
//
// Only JSON is considered — an SSE stream or an audio blob is passed through
// untouched. The buffer is bounded by maxUsagePeek; a reply larger than that
// is streamed normally and counted as zero tokens rather than held in RAM,
// which is the zero-RAM rule doing its job.
func peekTokens(resp *http.Response, service string) (tokensIn, tokensOut int) {
	if resp == nil || resp.Body == nil {
		return 0, 0
	}
	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if ct != "" && !strings.Contains(ct, "json") {
		return 0, 0
	}

	limited := io.LimitReader(resp.Body, maxUsagePeek+1)
	buf, err := io.ReadAll(limited)

	// Hand the bytes back before anything else can fail: the caller's read
	// must never depend on whether parsing worked.
	rest := resp.Body
	resp.Body = &readBackCloser{
		Reader: io.MultiReader(bytes.NewReader(buf), rest),
		Closer: rest,
	}
	if err != nil || len(buf) > maxUsagePeek {
		return 0, 0
	}
	if len(buf) == 0 {
		return 0, 0
	}

	switch service {
	case "groq":
		var body struct {
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(buf, &body); err == nil {
			in := body.Usage.PromptTokens
			out := body.Usage.CompletionTokens
			if in == 0 && out == 0 && body.Usage.TotalTokens > 0 {
				// Groq answers some endpoints with a total only.
				out = body.Usage.TotalTokens
			}
			return in, out
		}
	case "gemini":
		var body struct {
			UsageMetadata struct {
				PromptTokenCount     int `json:"promptTokenCount"`
				CandidatesTokenCount int `json:"candidatesTokenCount"`
			} `json:"usageMetadata"`
		}
		if err := json.Unmarshal(buf, &body); err == nil {
			return body.UsageMetadata.PromptTokenCount, body.UsageMetadata.CandidatesTokenCount
		}
	}
	return 0, 0
}

// readBackCloser restores the body: the bytes already read come first, then
// whatever is left of the original stream, closed with the original closer.
type readBackCloser struct {
	io.Reader
	io.Closer
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
