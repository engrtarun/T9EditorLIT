package dl

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// The settings are stored by the app (SQLite) and pushed here, so the daemon's
// own answer is the one the UI compares against. These tests pin the two
// things a push can get wrong: a number out of range must be clamped rather
// than trusted, and a missing folder must be created instead of making every
// later download fail at open time.
func TestSettingsAreClampedAndTheFolderIsCreated(t *testing.T) {
	m, err := New(Options{
		Dir:             t.TempDir(),
		Segments:        8,
		MinSegmentBytes: 64 << 10,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(m.Shutdown)

	target := filepath.Join(t.TempDir(), "nested", "downloads")
	got, err := m.ApplySettings(Settings{Connections: 99, SaveDir: target, AutoResume: true})
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	if got.Connections != HardMaxSegments {
		t.Fatalf("connections should clamp to %d, got %d", HardMaxSegments, got.Connections)
	}
	if got.SaveDir != target {
		t.Fatalf("save dir = %q, want %q", got.SaveDir, target)
	}
	if st, err := os.Stat(target); err != nil || !st.IsDir() {
		t.Fatalf("the save folder was not created: %v", err)
	}
	if again := m.Settings(); again != got {
		t.Fatalf("Settings() = %+v, want the applied %+v", again, got)
	}

	// Zero is "use the default", not "no sockets": a UI that has never saved
	// anything must not hand the downloader a zero-socket plan.
	got, err = m.ApplySettings(Settings{Connections: 0, SaveDir: target})
	if err != nil {
		t.Fatalf("ApplySettings(0): %v", err)
	}
	if got.Connections != DefaultSegments {
		t.Fatalf("connections 0 should fall back to %d, got %d", DefaultSegments, got.Connections)
	}
	if got.AutoResume {
		t.Fatalf("auto-resume should keep the requested false, got true")
	}
}

// A range-less host is the normal case on Google's video CDN, and a resumed
// download there re-reads the prefix because the server always answers from
// byte 0. That re-read is real socket activity; the stall watchdog used to
// watch only written bytes, so it cut a perfectly healthy connection after
// `stallLimit` and started the prefix again. The proof is the server's GET
// count: the fixed downloader resumes with exactly one new GET.
func TestNonRangedResumeIsNotKilledByTheStallWatchdog(t *testing.T) {
	blob := make([]byte, 1<<20)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}

	var gets atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK) // no Accept-Ranges: a plain host
			return
		}
		gets.Add(1)
		// 16 KiB every 20 ms: a 512 KiB prefix takes ~640 ms to re-read,
		// comfortably longer than the shortened stall limit below.
		for off := 0; off < len(blob); off += 16 << 10 {
			end := off + 16<<10
			if end > len(blob) {
				end = len(blob)
			}
			if _, err := w.Write(blob[off:end]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	// Shorten the watchdog for the test only. Package tests run sequentially,
	// so this cannot leak into another test's timing.
	oldLimit, oldEvery := stallLimit, stallEvery
	stallLimit, stallEvery = 300*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { stallLimit, stallEvery = oldLimit, oldEvery })

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Pause only once at least 512 KiB are on disk, so the re-read is
	// guaranteed to outlast the watchdog.
	deadline := time.Now().Add(5 * time.Second)
	for {
		row := m.List()[0]
		if row.ReceivedBytes >= 512<<10 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never reached 512 KiB, stuck at %d", row.ReceivedBytes)
		}
	}
	if _, err := m.Pause(item.ID); err != nil {
		t.Fatalf("Pause: %v", err)
	}

	paused := m.List()[0].ReceivedBytes
	if paused < 512<<10 {
		t.Fatalf("pause landed at %d bytes, want >= 512 KiB", paused)
	}
	// Probes happen during Start, and they also use GETs on this host (no
	// Accept-Ranges means "ask with a real Range request"). What matters for
	// the watchdog is how many GETs the resume needs: exactly one.
	baseline := gets.Load()
	if _, err := m.Resume(item.ID); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	// While the prefix is crossing the network a second time the row must say
	// so, and the re-read bytes must be reported: that is the difference
	// between "working" and "stuck at 0.0 MB/s" for the user.
	sawResuming := false
	var reread int64
	for {
		row := m.List()[0]
		if row.Phase == "resuming" {
			sawResuming = true
		}
		if row.ReReadBytes > reread {
			reread = row.ReReadBytes
		}
		if row.Status != StatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("resume never finished; row = %+v", row)
		}
		time.Sleep(5 * time.Millisecond)
	}

	done := waitStatus(t, m, item.ID, StatusDone)
	if sawResuming == false {
		t.Fatalf("the row never reported phase=resuming during the prefix re-read")
	}
	if reread < paused {
		t.Fatalf("rereadBytes = %d, want at least the %d bytes re-read from the prefix", reread, paused)
	}
	if n := gets.Load() - baseline; n != 1 {
		t.Fatalf("the resume made %d GETs, want 1 - more than one means the "+
			"stall watchdog cut the re-read and started over", n)
	}
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("the resumed file is not byte-identical")
	}
}

// The daemon can be restarted by the supervisor at any moment, and it starts
// before the app has pushed the SQLite row. The startup cache is what makes
// autoResume (and the socket count) honest during that window. This is the
// proof that a second Manager opens with the first one's applied settings.
func TestSettingsSurviveADaemonRestart(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "dl-settings.json")
	opts := func(dir string) Options {
		return Options{
			Dir:             dir,
			SettingsPath:    cache,
			Segments:        8,
			MinSegmentBytes: 64 << 10,
		}
	}

	first, err := New(opts(t.TempDir()))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	chosen := filepath.Join(t.TempDir(), "chosen")
	want, err := first.ApplySettings(Settings{
		Connections: 3,
		SaveDir:     chosen,
		AutoResume:  false,
		NotifyDone:  false,
	})
	if err != nil {
		t.Fatalf("ApplySettings: %v", err)
	}
	first.Shutdown()

	second, err := New(opts(t.TempDir()))
	if err != nil {
		t.Fatalf("New after restart: %v", err)
	}
	t.Cleanup(second.Shutdown)
	if got := second.Settings(); got != want {
		t.Fatalf("restart lost the settings:\n got %+v\nwant %+v", got, want)
	}
}

// Cancel deletes the `.part` and its sidecar. The row stayed in the queue as
// `cancelled`, and Start found it before probing: every re-add of that same
// link answered 502 ErrBusy until the daemon restarted. A cancelled row is
// dead weight, not a download to resume.
func TestCancelledRowCanBeStartedAgain(t *testing.T) {
	blob := make([]byte, 512<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK) // no Accept-Ranges: a plain host
			return
		}
		if r.Header.Get("Range") != "" {
			// A range probe on a host that does not support ranges: answer
			// 200 with the whole body, exactly like the real CDN does.
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(blob)
			return
		}
		for off := 0; off < len(blob); off += 16 << 10 {
			end := off + 16<<10
			if end > len(blob) {
				end = len(blob)
			}
			if _, err := w.Write(blob[off:end]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(20 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	first, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// Cancel while it is genuinely running: a done row's cancel is a no-op.
	deadline := time.Now().Add(3 * time.Second)
	for m.List()[0].ReceivedBytes == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := m.Cancel(first.ID); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if st := m.List()[0].Status; st != StatusCancelled {
		t.Fatalf("status after cancel = %q, want %q", st, StatusCancelled)
	}

	second, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("re-adding a cancelled link must work, got: %v", err)
	}
	if second.ID == first.ID {
		t.Fatalf("a cancelled row should be forgotten, not reused (id %s)", second.ID)
	}
	waitStatus(t, m, second.ID, StatusDone)
}
