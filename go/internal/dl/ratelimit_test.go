package dl

import (
	"bytes"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// segmentRange is the Range a worker sends (never the probe's bytes=0-0).
func segmentRange(r *http.Request) bool {
	h := r.Header.Get("Range")
	return h != "" && h != "bytes=0-0"
}

// TestRateLimitedSegmentKeepsGoing: a host that answers 429 to two workers
// must not kill the file. Before the rate-limit handling those two answers
// burned the whole five-retry budget in under a second and the row went red
// while the server was perfectly happy to serve a moment later.
func TestRateLimitedSegmentKeepsGoing(t *testing.T) {
	old := rateLimitBase
	rateLimitBase = 2 * time.Millisecond
	defer func() { rateLimitBase = old }()

	blob := bytes.Repeat([]byte("t9"), 40<<10) // 80 KiB, splits into 4
	rs := &rangeServer{data: blob}
	var blocked atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if segmentRange(r) && blocked.Add(1) <= 2 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		rs.handler(w, r)
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/big.bin", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	final := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(final.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("file differs from the source")
	}
	// A 429 must also cost the host fewer sockets - sixteen requests to a
	// server that wants four is what turns a slow moment into a ban.
	d, err := m.get(item.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	d.gateMu.Lock()
	limit := d.concLimit
	total := len(d.segs)
	d.gateMu.Unlock()
	if total > 2 && limit >= total {
		t.Fatalf("a 429 left all %d sockets open (limit %d)", total, limit)
	}
}

// TestTransientErrorsKeepRetryingBeyondTheOldBudget: a 90 GB download takes
// hours, and the network is allowed more than five bad moments. The old
// five-attempt budget failed the whole row; now only a permanent refusal or a
// host that has gone completely silent ends it.
func TestTransientErrorsKeepRetryingBeyondTheOldBudget(t *testing.T) {
	prevBase := retryBase
	retryBase = 5 * time.Millisecond
	t.Cleanup(func() { retryBase = prevBase })

	blob := bytes.Repeat([]byte("t9"), 40<<10)
	rs := &rangeServer{data: blob}
	var drops atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if segmentRange(r) && drops.Add(1) <= 8 {
			// The shape of a busy CDN: the socket dies before any header.
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					c.Close()
				}
			}
			return
		}
		rs.handler(w, r)
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/big.bin", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	final := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(final.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("file differs from the source")
	}
	if drops.Load() <= MaxRetries {
		t.Fatalf("the test must exceed the old %d attempt budget, saw %d drops", MaxRetries, drops.Load())
	}
}

// TestStallWatchdogEndsARowWhoseHostWentSilent: retrying a transient error
// forever is right, waiting forever is not. A host that answers the request
// and then never sends a byte must end as a failed row with an honest message
// instead of a "running" bar that never moves.
func TestStallWatchdogEndsARowWhoseHostWentSilent(t *testing.T) {
	prevLimit, prevEvery, prevIdle := stallLimit, stallEvery, idleTimeout
	stallLimit, stallEvery, idleTimeout = 400*time.Millisecond, 50*time.Millisecond, time.Hour
	t.Cleanup(func() { stallLimit, stallEvery, idleTimeout = prevLimit, prevEvery, prevIdle })

	blob := bytes.Repeat([]byte("t9"), 40<<10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		// Headers, then silence: connected, alive, and producing nothing.
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(blob)-1, len(blob)))
		w.WriteHeader(http.StatusPartialContent)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/silent.bin", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dead := waitStatus(t, m, item.ID, StatusError)
	if !strings.Contains(dead.Error, "koi byte nahi") {
		t.Fatalf("want the stall message, got %q", dead.Error)
	}
	// A failed row keeps its `.part` (and the handle on it) so Retry can
	// resume; closing it here is only so TempDir can be removed on Windows.
	_, _ = m.Cancel(item.ID)
}

// TestResumeAfterAPermanentRefusal is the user's recovery path: the row went
// red at 25% (an expired token, then a fresh link), and "Retry" must continue
// from the bytes already on disk rather than restarting a multi-GB file from
// zero. It also proves the daemon accepts a resume from `error` (it used to
// answer ErrBusy, so a failed row could only ever be dismissed).
func TestResumeAfterAPermanentRefusal(t *testing.T) {
	blob := bytes.Repeat([]byte("t9"), 200<<10)

	// 1 = refuse every worker whose range does not start at byte 0, so the
	// download can only make progress through segment 0 and then dies.
	var mode atomic.Int32
	mode.Store(1)

	// Counted across the resume only: a resume that asks for the bytes already
	// on disk is the bug this whole file exists to prevent.
	var served atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode.Load() == 1 && segmentRange(r) && !strings.HasPrefix(r.Header.Get("Range"), "bytes=0-") {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		cw := &countingWriter{ResponseWriter: w, n: &served}
		http.ServeContent(cw, r, "big.bin", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/big.bin", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	dead := waitStatus(t, m, item.ID, StatusError)
	if dead.ReceivedBytes == 0 {
		t.Fatalf("the first attempt should have written segment 0 before dying")
	}

	mode.Store(0)
	served.Store(0)
	if _, err := m.Resume(item.ID); err != nil {
		t.Fatalf("a failed row must be resumable: %v", err)
	}
	final := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(final.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("file differs from the source")
	}
	if final.ReceivedBytes != int64(len(blob)) {
		t.Fatalf("row reports %d of %d bytes", final.ReceivedBytes, len(blob))
	}
	if s := served.Load(); s > int64(len(blob)) {
		t.Fatalf("resume re-downloaded %d bytes of a %d byte file", s, len(blob))
	}
}

// TestSocketBudgetComesBackWhenTheHostGoesQuiet: after a 429 the budget was
// only ever refilled by a *finished* segment - hours away on a 90 GB file, so
// one early rate limit left the whole transfer on two sockets (measured: 24.9
// MB/s before the 429, 8 MB/s for the rest of the 1 GB). The timer hands one
// socket back per quiet stretch, never above the segment count.
func TestSocketBudgetComesBackWhenTheHostGoesQuiet(t *testing.T) {
	prevAfter := limitRecoverAfter
	t.Cleanup(func() { limitRecoverAfter = prevAfter })

	d := &download{segs: make([]*segment, 8), log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	d.concLimit = 8
	d.slowDown() // 8 -> 4
	d.slowDown() // 4 -> 2
	if d.concLimit != 2 {
		t.Fatalf("two 429s must leave two sockets, got %d", d.concLimit)
	}

	// Still inside the quiet window: nothing is handed back.
	limitRecoverAfter = time.Hour
	d.maybeSpeedUp()
	if d.concLimit != 2 {
		t.Fatalf("a recent 429 must not hand a socket back, got %d", d.concLimit)
	}

	// Quiet since long enough: one socket.
	limitRecoverAfter = 0
	d.maybeSpeedUp()
	if d.concLimit != 3 {
		t.Fatalf("a quiet host must get one socket back, got %d", d.concLimit)
	}

	// And it never climbs past the segment count.
	for i := 0; i < 20; i++ {
		d.maybeSpeedUp()
	}
	if d.concLimit != 8 {
		t.Fatalf("budget must stop at the segment count, got %d", d.concLimit)
	}
}

// TestRetryAfterParsesSeconds: the header is what the server itself said, and
// ignoring it (or treating a date as zero) throws away the only instruction
// that came with the 429.
func TestRetryAfterParsesSeconds(t *testing.T) {
	if got := retryAfter("7"); got != 7*time.Second {
		t.Fatalf("want 7s, got %s", got)
	}
	if got := retryAfter(""); got != 0 {
		t.Fatalf("want 0 for an empty header, got %s", got)
	}
	if got := retryAfter("Wed, 21 Oct 2026 07:28:00 GMT"); got != 0 {
		t.Fatalf("an HTTP-date falls back to the exponential backoff, got %s", got)
	}
	if got := retryAfter("9999"); got != 2*time.Minute {
		t.Fatalf("a silly delay must be capped, got %s", got)
	}
	if !isRateLimited(http.StatusTooManyRequests) || !isRateLimited(http.StatusServiceUnavailable) {
		t.Fatalf("429 and 503 are rate limits")
	}
	if isRateLimited(http.StatusForbidden) {
		t.Fatalf("403 is a refusal, not a rate limit")
	}
}
