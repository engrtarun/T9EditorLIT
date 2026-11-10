package ublock

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// buildZip makes a real archive in memory, so the updater is exercised through
// archive/zip instead of a stub that could never catch a bad extractor.
func buildZip(t *testing.T, prefix string, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(prefix + name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

type releaseServer struct {
	t       *testing.T
	srv     *httptest.Server
	mu      sync.Mutex
	tag     string
	payload []byte
	digest  string // empty = compute from payload
	apiHits atomic.Int64
	dlHits  atomic.Int64
}

func newReleaseServer(t *testing.T, tag string, payload []byte) *releaseServer {
	t.Helper()
	rs := &releaseServer{t: t, tag: tag, payload: payload}
	rs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api":
			rs.apiHits.Add(1)
			rs.mu.Lock()
			tag, payload, digest := rs.tag, rs.payload, rs.digest
			rs.mu.Unlock()
			if digest == "" {
				sum := sha256.Sum256(payload)
				digest = "sha256:" + hex.EncodeToString(sum[:])
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"tag_name": tag,
				"assets": []map[string]any{{
					"name":                 fmt.Sprintf("uBlock0_%s.chromium.zip", tag),
					"size":                 len(payload),
					"digest":               digest,
					"browser_download_url": rs.srv.URL + "/download",
				}},
			})
		case "/download":
			rs.dlHits.Add(1)
			rs.mu.Lock()
			payload := rs.payload
			rs.mu.Unlock()
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func (rs *releaseServer) set(tag string, payload []byte) {
	rs.mu.Lock()
	rs.tag, rs.payload, rs.digest = tag, payload, ""
	rs.mu.Unlock()
}

// badDigest makes the API lie about the archive, the way a corrupted or
// intercepted download would look.
func (rs *releaseServer) badDigest() {
	rs.mu.Lock()
	rs.digest = "sha256:" + string(bytes.Repeat([]byte("0"), 64))
	rs.mu.Unlock()
}

func useServer(t *testing.T, rs *releaseServer) {
	t.Helper()
	oldAPI, oldInsecure := apiURL, allowInsecure
	apiURL = rs.srv.URL + "/api"
	allowInsecure = true
	t.Cleanup(func() { apiURL, allowInsecure = oldAPI, oldInsecure })
}

func manifestFor(version string) string {
	return fmt.Sprintf(`{"manifest_version":2,"name":"uBlock Origin","version":%q}`, version)
}

func TestEnsureInstallsTheVerifiedReleaseAndDoesNotRedownloadIt(t *testing.T) {
	zb := buildZip(t, ExtensionFolder+"/", map[string]string{
		"manifest.json":    manifestFor("1.99.0"),
		"js/background.js": "// uBlock background stub",
	})
	rs := newReleaseServer(t, "1.99.0", zb)
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	if err := u.checkAndInstall(context.Background()); err != nil {
		t.Fatalf("checkAndInstall: %v", err)
	}

	st := u.Status()
	if !st.Installed || st.Version != "1.99.0" {
		t.Fatalf("status = %+v, want installed 1.99.0", st)
	}
	if !manifestExists(u.ExtensionDir()) {
		t.Fatalf("manifest.json missing at %s", u.ExtensionDir())
	}
	if _, err := os.Stat(filepath.Join(u.ExtensionDir(), "js", "background.js")); err != nil {
		t.Fatalf("nested file missing: %v", err)
	}
	m := u.readMarker()
	wantSum := sha256.Sum256(zb)
	if m.SHA256 != hex.EncodeToString(wantSum[:]) {
		t.Fatalf("marker sha = %q, want the archive digest", m.SHA256)
	}

	// The next check sees the same release: one API question, zero downloads.
	apiBefore, dlBefore := rs.apiHits.Load(), rs.dlHits.Load()
	if err := u.checkAndInstall(context.Background()); err != nil {
		t.Fatalf("second checkAndInstall: %v", err)
	}
	if rs.apiHits.Load() <= apiBefore {
		t.Fatalf("the update check must still ask GitHub (auto-update)")
	}
	if got := rs.dlHits.Load(); got != dlBefore {
		t.Fatalf("redownloaded an unchanged release: %d -> %d", dlBefore, got)
	}
}

func TestANewReleaseReplacesTheInstalledOne(t *testing.T) {
	v1 := buildZip(t, ExtensionFolder+"/", map[string]string{"manifest.json": manifestFor("1.0.0")})
	v2 := buildZip(t, ExtensionFolder+"/", map[string]string{"manifest.json": manifestFor("2.0.0")})
	rs := newReleaseServer(t, "1.0.0", v1)
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	if err := u.checkAndInstall(context.Background()); err != nil {
		t.Fatalf("install v1: %v", err)
	}
	rs.set("2.0.0", v2)
	if err := u.checkAndInstall(context.Background()); err != nil {
		t.Fatalf("update to v2: %v", err)
	}
	if st := u.Status(); st.Version != "2.0.0" {
		t.Fatalf("version = %q, want 2.0.0", st.Version)
	}
	b, err := os.ReadFile(filepath.Join(u.ExtensionDir(), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(b, []byte("2.0.0")) {
		t.Fatalf("manifest still old: %s", b)
	}
}

func TestAHashMismatchNeverTouchesTheExtensionFolder(t *testing.T) {
	zb := buildZip(t, ExtensionFolder+"/", map[string]string{"manifest.json": manifestFor("3.0.0")})
	rs := newReleaseServer(t, "3.0.0", zb)
	rs.badDigest()
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	err := u.checkAndInstall(context.Background())
	if err == nil {
		t.Fatal("a wrong digest must fail the update")
	}
	if manifestExists(u.ExtensionDir()) {
		t.Fatal("a tampered archive was unpacked")
	}
	if st := u.Status(); st.Installed {
		t.Fatalf("status claims installed after a bad digest: %+v", st)
	}
}

func TestZipTraversalIsRejected(t *testing.T) {
	zb := buildZip(t, ExtensionFolder+"/", map[string]string{
		"manifest.json": manifestFor("4.0.0"),
		"../escape.txt": "should never land",
	})
	rs := newReleaseServer(t, "4.0.0", zb)
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	if err := u.checkAndInstall(context.Background()); err == nil {
		t.Fatal("a traversal entry must fail the update")
	}
	escape := filepath.Join(u.dir, "..", "escape.txt")
	if _, err := os.Stat(escape); err == nil {
		t.Fatalf("traversal wrote %s", escape)
	}
}

func TestABrokenUpdateKeepsTheWorkingVersion(t *testing.T) {
	good := buildZip(t, ExtensionFolder+"/", map[string]string{"manifest.json": manifestFor("1.5.0")})
	rs := newReleaseServer(t, "1.5.0", good)
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	if err := u.checkAndInstall(context.Background()); err != nil {
		t.Fatalf("install: %v", err)
	}
	rs.set("1.6.0", []byte("this is not a zip"))
	if err := u.checkAndInstall(context.Background()); err == nil {
		t.Fatal("a corrupt archive must fail the update")
	}
	if st := u.Status(); !st.Installed || st.Version != "1.5.0" {
		t.Fatalf("the working version was lost: %+v", st)
	}
}

// UpdateNow is the button the panel draws. It used to set the in-flight flag
// before launching the worker, and the worker bailed on that same flag — every
// manual "check now" answered `updating: true` and did nothing. The proof is
// that the release actually lands without any Start() tick.
func TestUpdateNowActuallyRunsTheCheck(t *testing.T) {
	zb := buildZip(t, ExtensionFolder+"/", map[string]string{"manifest.json": manifestFor("2.5.0")})
	rs := newReleaseServer(t, "2.5.0", zb)
	useServer(t, rs)

	u := New(t.TempDir(), discardLogger())
	first := u.UpdateNow(context.Background())
	if !first.Updating {
		t.Fatalf("the POST answer must say a check is in flight: %+v", first)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		st := u.Status()
		if !st.Updating {
			if !st.Installed || st.Version != "2.5.0" {
				t.Fatalf("check finished but nothing was installed: %+v", st)
			}
			if rs.dlHits.Load() == 0 {
				t.Fatal("the archive was never downloaded")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the check never finished: %+v", u.Status())
}

func TestStatusIsHonestBeforeTheFirstInstall(t *testing.T) {
	u := New(t.TempDir(), discardLogger())
	st := u.Status()
	if st.Installed || st.Version != "" {
		t.Fatalf("fresh status must be not-installed: %+v", st)
	}
	if !st.Enabled || !st.AutoUpdate {
		t.Fatalf("uBlock is shipped on and auto-updating: %+v", st)
	}
	if filepath.Base(st.Path) != "extensions" {
		t.Fatalf("path = %q, want the extensions folder", st.Path)
	}
}
