package dl

import (
	"bytes"
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
	if blocked.Load() < 2 {
		t.Fatalf("the test never got a 429 (%d requests)", blocked.Load())
	}
}

// TestResumeAfterARateLimitedFailure is the user's recovery path: the row went
// red at 25%, and "Retry" must continue from the bytes already on disk rather
// than restarting a multi-GB file from zero. It also proves the daemon now
// accepts a resume from `error` (it used to answer ErrBusy, so a failed row
// could only ever be dismissed).
func TestResumeAfterARateLimitedFailure(t *testing.T) {
	old := rateLimitBase
	rateLimitBase = 2 * time.Millisecond
	defer func() { rateLimitBase = old }()

	blob := bytes.Repeat([]byte("t9"), 200<<10)

	// 1 = reject every worker whose range does not start at byte 0, so the
	// download can only make progress through segment 0 and then dies.
	var mode atomic.Int32
	mode.Store(1)

	// Counted across the resume only: a resume that asks for the bytes already
	// on disk is the bug this whole file exists to prevent.
	var served atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if mode.Load() == 1 && segmentRange(r) && !strings.HasPrefix(r.Header.Get("Range"), "bytes=0-") {
			w.WriteHeader(http.StatusTooManyRequests)
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
