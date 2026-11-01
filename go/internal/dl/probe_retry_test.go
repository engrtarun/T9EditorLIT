package dl

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// dropFirstServer closes the first `drop` connections mid-request — the exact
// shape of a busy host (or a CDN recycling a socket) that made one EOF the
// whole answer before probeRetry existed.
func dropFirstServer(t *testing.T, drop int, blob []byte) *httptest.Server {
	t.Helper()
	var mu sync.Mutex
	left := drop
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		fail := left > 0
		if fail {
			left--
		}
		mu.Unlock()
		if fail {
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					c.Close()
				}
			}
			return
		}
		http.ServeContent(w, r, "big.bin", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestProbeRetrySurvivesADroppedConnection is the "start hi nahi hua" bug from
// the other side: HEAD, Range and the plain GET all died with EOF, the daemon
// answered "the server refuses to give the file", and a healthy link looked
// broken. The probe now asks again.
func TestProbeRetrySurvivesADroppedConnection(t *testing.T) {
	blob := bytes.Repeat([]byte("t9"), 40<<10)
	srv := dropFirstServer(t, 3, blob)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/big.bin", "")
	if err != nil {
		t.Fatalf("a host that dropped the first three connections must still start: %v", err)
	}
	final := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(final.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("file differs from the source")
	}
}

// TestProbeFallsBackToANeutralUserAgent covers the host that closes the
// socket the moment it sees a browser UA (Hetzner's speed server does this,
// 3 out of 3 for Chrome, 0 out of 3 for curl). Before the fallback the user
// was told "the server refuses to give the file" for a link that works in
// curl; now the probe changes identity once before failing, and the transfer
// keeps the identity that worked.
func TestProbeFallsBackToANeutralUserAgent(t *testing.T) {
	blob := bytes.Repeat([]byte("t9"), 40<<10)
	var plainHits int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == uaBrowser {
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					c.Close()
				}
			}
			return
		}
		atomic.AddInt32(&plainHits, 1)
		http.ServeContent(w, r, "big.bin", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/big.bin", "")
	if err != nil {
		t.Fatalf("a host that refuses the browser UA must still be startable: %v", err)
	}
	if atomic.LoadInt32(&plainHits) == 0 {
		t.Fatalf("the neutral UA was never used")
	}
	final := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(final.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("file differs from the source")
	}
}

// TestProbeDoesNotRetryAnErrorPage: an expired link or a captcha page is a
// real answer, not a hiccup. Asking three times (or under a second identity)
// only delays the message the user needs.
func TestProbeDoesNotRetryAnErrorPage(t *testing.T) {
	var served int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&served, 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "<!doctype html><title>link expired</title>")
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	_, err := m.Start(srv.URL+"/gone", "")
	if err == nil {
		t.Fatalf("an HTML page must not start a download")
	}
	if err != errHTMLPage {
		t.Fatalf("want the honest error-page message, got %v", err)
	}
	if n := atomic.LoadInt32(&served); n > 3 {
		t.Fatalf("the error page was fetched %d times - retrying cannot fix a dead link", n)
	}
}
