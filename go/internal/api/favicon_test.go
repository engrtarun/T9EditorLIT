package api

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newFaviconServer builds a server whose faviconDir points at a temp folder
// so the cache never touches the real user's cache directory.
func newFaviconServer(t *testing.T) *Server {
	t.Helper()
	dir := t.TempDir()
	s := &Server{
		deps:       Deps{Log: slog.New(slog.NewTextHandler(io.Discard, nil))},
		mux:        http.NewServeMux(),
		faviconDir: dir,
	}
	return s
}

func TestFaviconFetchesCachesAndServes(t *testing.T) {
	// A site that answers /favicon.ico with a tiny image.
	var fetches int
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 1, 2, 3})
	}))
	t.Cleanup(site.Close)

	s := newFaviconServer(t)

	// First call: fetches from the site and caches.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil)
	s.handleFavicon(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/x-icon" {
		t.Errorf("Content-Type = %q, want image/x-icon", ct)
	}
	if fetches != 1 {
		t.Errorf("site fetches = %d, want 1", fetches)
	}

	// Second call: served from disk, no new fetch.
	rec2 := httptest.NewRecorder()
	s.handleFavicon(rec2, httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil))
	if rec2.Code != http.StatusOK {
		t.Errorf("cached status = %d, want 200", rec2.Code)
	}
	if fetches != 1 {
		t.Errorf("site fetches after cache hit = %d, want still 1", fetches)
	}
}

func TestFaviconRejectsNonHTTPURLs(t *testing.T) {
	s := newFaviconServer(t)
	for _, raw := range []string{"", "ftp://x/y", "file:///x", "not-a-url"} {
		rec := httptest.NewRecorder()
		s.handleFavicon(rec, httptest.NewRequest("GET", "/v1/favicon?url="+raw, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("url %q: status = %d, want 400", raw, rec.Code)
		}
	}
}

func TestFaviconRefusesNonImageResponses(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not an icon</html>"))
	}))
	t.Cleanup(site.Close)

	s := newFaviconServer(t)
	rec := httptest.NewRecorder()
	s.handleFavicon(rec, httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil))

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
	// The cache must not hold a bad file.
	entries, _ := os.ReadDir(s.faviconDir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ico") {
			t.Errorf("bad response was cached as %s", e.Name())
		}
	}
}

func TestFaviconCacheFileIsOnDisk(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 'P', 'N', 'G'})
	}))
	t.Cleanup(site.Close)

	s := newFaviconServer(t)
	rec := httptest.NewRecorder()
	s.handleFavicon(rec, httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	entries, _ := os.ReadDir(s.faviconDir)
	found := false
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ico") {
			found = true
			// Must be non-empty and a regular file.
			info, err := e.Info()
			if err != nil {
				t.Fatalf("stat: %v", err)
			}
			if info.Size() == 0 {
				t.Errorf("cached icon is empty")
			}
			break
		}
	}
	if !found {
		t.Errorf("no .ico in the cache dir: %v", entries)
	}
}

func TestFaviconTTLExpiry(t *testing.T) {
	// The cache TTL is 7 days; age the file and verify the proxy re-fetches.
	var fetches int
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches++
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte{0x89, 'P', 'N', 'G', 9, 9, 9})
	}))
	t.Cleanup(site.Close)

	s := newFaviconServer(t)

	// Prime the cache.
	rec := httptest.NewRecorder()
	s.handleFavicon(rec, httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("prime status = %d, want 200", rec.Code)
	}
	if fetches != 1 {
		t.Fatalf("prime fetches = %d, want 1", fetches)
	}

	// Age the cache file beyond the TTL.
	entries, _ := os.ReadDir(s.faviconDir)
	var realPath string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".ico") {
			realPath = filepath.Join(s.faviconDir, e.Name())
			break
		}
	}
	if realPath == "" {
		t.Fatal("no cache file found")
	}
	old := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(realPath, old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	// Next request must re-fetch (fetches goes to 2).
	rec2 := httptest.NewRecorder()
	s.handleFavicon(rec2, httptest.NewRequest("GET", "/v1/favicon?url="+site.URL+"/favicon.ico", nil))
	if rec2.Code != http.StatusOK {
		t.Errorf("re-fetch status = %d, want 200", rec2.Code)
	}
	if fetches != 2 {
		t.Errorf("fetches after TTL expiry = %d, want 2 (the proxy should have re-fetched)", fetches)
	}
}
