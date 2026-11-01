package dl

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestRangeIsProvenAtMidFileNotJustAtZero is the bug the user hit: a host that
// answers 200 to `bytes=0-0` but 206 to a mid-file range. One probe answer of
// "no range" put a 9.6 GB file on ONE socket for its whole life; the second
// question is what turns that into sixteen.
func TestRangeIsProvenAtMidFileNotJustAtZero(t *testing.T) {
	blob := make([]byte, 300<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			// A CDN edge that does not advertise range support.
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		// The first byte is refused as a range, everything else is honoured.
		if r.Header.Get("Range") == "bytes=0-0" {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(blob)
			return
		}
		http.ServeContent(w, r, "clip.mp4", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/clip.mp4", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := waitStatus(t, m, item.ID, StatusDone)

	if done.Segments < 4 {
		t.Errorf("segments = %d, want the file split (a mid-file 206 proves range support)", done.Segments)
	}
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("file differs from the source")
	}
}

// TestWidenSplitsASingleSocketTransfer is the mid-flight twin: the probe is
// told "no range" (twice, under both User-Agents), the transfer starts on one
// socket, and the host starts honouring Range a moment later. The row must
// notice and re-plan instead of staying at 1/16 of the link for nine gigabytes.
func TestWidenSplitsASingleSocketTransfer(t *testing.T) {
	prevAfter, prevRemaining := widenAfter, minWidenRemaining
	widenAfter, minWidenRemaining = 40*time.Millisecond, 0
	t.Cleanup(func() { widenAfter, minWidenRemaining = prevAfter, prevRemaining })

	blob := make([]byte, 400<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}
	// `hot` flips once the plain GET has actually delivered bytes: from then
	// on the host answers Range requests, which is what a CDN edge does when
	// the object becomes cacheable.
	var hot atomic.Bool

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Header.Get("Range") != "" {
			if !hot.Load() {
				w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(blob)
				return
			}
			http.ServeContent(w, r, "clip.mp4", time.Unix(0, 0), bytes.NewReader(blob))
			return
		}
		// The single-socket transfer: slow enough that the widening watcher
		// fires while it is still running.
		w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
		w.WriteHeader(http.StatusOK)
		for off := 0; off < len(blob); off += 4 << 10 {
			end := off + 4<<10
			if end > len(blob) {
				end = len(blob)
			}
			if _, err := w.Write(blob[off:end]); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			hot.Store(true)
			time.Sleep(3 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/clip.mp4", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := waitStatus(t, m, item.ID, StatusDone)

	if done.Segments < 2 {
		t.Errorf("segments = %d, want the row re-planned for parallel ranges", done.Segments)
	}
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("the widened transfer wrote the wrong bytes")
	}
}

// TestStallReconnectsBeforeItFails is "background me download band ho gaya":
// a socket that stops sending is not a dead host. The row must force one fresh
// connection and carry on; only a second silent window may end it.
func TestStallReconnectsBeforeItFails(t *testing.T) {
	prevLimit, prevEvery, prevIdle := stallLimit, stallEvery, idleTimeout
	stallLimit, stallEvery, idleTimeout = 250*time.Millisecond, 20*time.Millisecond, time.Hour
	t.Cleanup(func() { stallLimit, stallEvery, idleTimeout = prevLimit, prevEvery, prevIdle })

	blob := make([]byte, 200<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}
	var attempts atomic.Int32

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		// The first connection: headers, then silence - the classic dead
		// socket. Every later one serves the file.
		if attempts.Add(1) == 1 {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(blob)-1, len(blob)))
			w.WriteHeader(http.StatusPartialContent)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		http.ServeContent(w, r, "clip.mp4", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL+"/clip.mp4", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := waitStatus(t, m, item.ID, StatusDone)

	if done.ReceivedBytes != int64(len(blob)) {
		t.Errorf("received = %d, want %d", done.ReceivedBytes, len(blob))
	}
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("file differs from the source after the reconnect")
	}
}

// TestSidecarWithADifferentSplitIsAdopted covers the pause/restart that
// follows a widen: the sidecar's plan no longer matches the split Start would
// compute, and the bytes on disk must survive anyway. A plan that tiles the
// file exactly is safe to adopt whatever its shape.
func TestSidecarWithADifferentSplitIsAdopted(t *testing.T) {
	blob := make([]byte, 400<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.Header().Set("ETag", `"blob-v1"`)
			w.WriteHeader(http.StatusOK)
			return
		}
		// Give the assertion below a window before any new byte lands.
		time.Sleep(40 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		http.ServeContent(w, r, "big.rar", time.Unix(0, 0), bytes.NewReader(blob))
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)

	// A two-segment plan (the manager would compute four) whose first segment
	// is already complete on disk.
	segs := splitSegments(int64(len(blob)), 2, true)
	done := []int64{segs[0].length(), 0}
	dest := filepath.Join(m.Dir(), "big.rar")
	part := dest + ".part"
	f, err := os.Create(part)
	if err != nil {
		t.Fatalf("create part: %v", err)
	}
	if err := f.Truncate(int64(len(blob))); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if _, err := f.WriteAt(blob[:done[0]], 0); err != nil {
		t.Fatalf("write first segment: %v", err)
	}
	f.Close()

	sc := sidecar{
		Version:    1,
		URL:        srv.URL + "/big.rar",
		Filename:   "big.rar",
		TotalBytes: int64(len(blob)),
		Ranged:     true,
		ETag:       `"blob-v1"`,
	}
	for i, s := range segs {
		sc.Segments = append(sc.Segments, segmentState{s.start, s.end, done[i]})
	}
	b, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal sidecar: %v", err)
	}
	if err := os.WriteFile(part+".json", b, 0o644); err != nil {
		t.Fatalf("write sidecar: %v", err)
	}

	item, err := m.Start(srv.URL+"/big.rar", "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if item.ReceivedBytes != done[0] {
		t.Errorf("received at start = %d, want %d (the sidecar's plan was thrown away)",
			item.ReceivedBytes, done[0])
	}
	doneItem := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(doneItem.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatal("file differs from the source after adopting a different split")
	}
}
