package dl

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// rangeServer serves a fixed blob and honours Range requests the way a real
// file host does — the honest double for the multi-segment path.
type rangeServer struct {
	mu   sync.Mutex
	data []byte
	// hits counts how many requests carried a Range header; the
	// multi-segment test asserts on it to prove splitting really happened.
	ranged int
	total  int
}

func (s *rangeServer) handler(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.total++
	rangeHdr := r.Header.Get("Range")
	if rangeHdr != "" {
		s.ranged++
	}
	s.mu.Unlock()

	if r.Method == http.MethodHead {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Length", fmt.Sprint(len(s.data)))
		w.Header().Set("ETag", `"blob-v1"`)
		w.Header().Set("Content-Disposition", `attachment; filename="sample file.mp4"`)
		w.WriteHeader(http.StatusOK)
		return
	}

	http.ServeContent(w, r, "sample file.mp4", time.Unix(0, 0), bytes.NewReader(s.data))
}

func newRangeServer(t *testing.T, size int) (*rangeServer, *httptest.Server) {
	t.Helper()
	blob := make([]byte, size)
	if _, err := rand.Read(blob); err != nil {
		t.Fatalf("rand: %v", err)
	}
	s := &rangeServer{data: blob}
	srv := httptest.NewServer(http.HandlerFunc(s.handler))
	t.Cleanup(srv.Close)
	return s, srv
}

func newTestManager(t *testing.T, srv *httptest.Server) *Manager {
	t.Helper()
	m, err := New(Options{
		Dir:             t.TempDir(),
		Log:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Segments:        4,
		MinSegmentBytes: 64 << 10,
		Client:          srv.Client(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(m.Shutdown)
	return m
}

// waitStatus polls until the download reaches a terminal state (or the
// deadline). Running is never terminal — the caller asks for what it wants.
func waitStatus(t *testing.T, m *Manager, id, want string) Item {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	var last Item
	for time.Now().Before(deadline) {
		for _, it := range m.List() {
			if it.ID == id {
				last = it
				if it.Status == want {
					return it
				}
				if it.Status == StatusError && want != StatusError {
					t.Fatalf("download went to error: %s", it.Error)
				}
			}
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %q; last seen %+v", want, last)
	return Item{}
}

func TestMultiSegmentDownloadReassemblesTheBytes(t *testing.T) {
	srv, tsrv := newRangeServer(t, 300<<10) // 300 KiB → four 75 KiB segments
	m := newTestManager(t, tsrv)

	item, err := m.Start(tsrv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if item.Status != StatusRunning {
		t.Fatalf("Start should hand back a running item, got %q", item.Status)
	}

	done := waitStatus(t, m, item.ID, StatusDone)

	if done.Segments != 4 {
		t.Errorf("segments = %d, want 4 (the file is well over the threshold)", done.Segments)
	}
	if done.TotalBytes != int64(len(srv.data)) {
		t.Errorf("totalBytes = %d, want %d", done.TotalBytes, len(srv.data))
	}
	if done.ReceivedBytes != int64(len(srv.data)) {
		t.Errorf("receivedBytes = %d, want %d", done.ReceivedBytes, len(srv.data))
	}
	if !strings.HasSuffix(done.Filename, ".mp4") {
		t.Errorf("filename = %q, want the server's name", done.Filename)
	}
	if strings.Contains(done.Filename, "sample file.mp4") && !strings.Contains(done.Filename, " ") {
		t.Errorf("filename %q lost its base name", done.Filename)
	}

	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading the finished file: %v", err)
	}
	if !bytes.Equal(got, srv.data) {
		t.Fatalf("the reassembled file differs from the source (%d vs %d bytes)", len(got), len(srv.data))
	}

	// The .part and its sidecar must be gone once done.
	if _, err := os.Stat(done.Path + ".part"); !os.IsNotExist(err) {
		t.Errorf(".part file survived the finish")
	}
	if _, err := os.Stat(done.Path + ".part.json"); !os.IsNotExist(err) {
		t.Errorf("sidecar survived the finish")
	}

	srv.mu.Lock()
	ranged, total := srv.ranged, srv.total
	srv.mu.Unlock()
	if ranged < 4 { // the four workers; the HEAD probe carries no Range
		t.Errorf("only %d/%d requests carried a Range header — splitting did not happen", ranged, total)
	}
}

func TestSingleConnectionWhenServerCannotRange(t *testing.T) {
	blob := bytes.Repeat([]byte("no-range-payload!"), 4096) // 68 KiB
	var mu sync.Mutex
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		// No Accept-Ranges, no 206: the plain-server answer.
		_, _ = w.Write(blob)
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)

	item, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := waitStatus(t, m, item.ID, StatusDone)

	if done.Segments != 1 {
		t.Errorf("segments = %d, want 1 on a server with no range support", done.Segments)
	}
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Errorf("file differs from the source")
	}
}

func TestPauseKeepsBytesAndResumeFinishes(t *testing.T) {
	// A slow server so the pause lands mid-flight: 1 KiB every 2 ms.
	blob := make([]byte, 400<<10)
	if _, err := rand.Read(blob); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		// Serve whole or ranged, slowly, in 4 KiB steps.
		start, end := int64(0), int64(len(blob)-1)
		if rng := r.Header.Get("Range"); rng != "" {
			var s, e int64
			if _, err := fmt.Sscanf(rng, "bytes=%d-%d", &s, &e); err == nil {
				start, end = s, e
				w.Header().Set("Content-Range",
					fmt.Sprintf("bytes %d-%d/%d", start, end, len(blob)))
				w.WriteHeader(http.StatusPartialContent)
			}
		}
		for off := start; off <= end; off += 4096 {
			n := int64(4096)
			if off+n > end+1 {
				n = end + 1 - off
			}
			if _, err := w.Write(blob[off : off+n]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			// ~10 ms per 4 KiB → a 100 KiB segment takes ~250 ms, so the
			// pause below (at 120 ms) lands mid-flight on every segment.
			time.Sleep(10 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)

	item, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// Let a few hundred KiB flow, then pull the plug.
	time.Sleep(120 * time.Millisecond)
	paused, err := m.Pause(item.ID)
	if err != nil {
		t.Fatalf("Pause: %v", err)
	}
	if paused.Status != StatusPaused {
		t.Fatalf("status after pause = %q", paused.Status)
	}

	// The sidecar must exist and describe every segment.
	scPath := paused.Path + ".part.json"
	if _, err := os.Stat(scPath); err != nil {
		t.Fatalf("sidecar missing after pause: %v", err)
	}

	// Wait for the writers to settle at their final offsets.
	time.Sleep(150 * time.Millisecond)
	settled := m.List()[0]
	partial := settled.ReceivedBytes
	if partial <= 0 || partial >= int64(len(blob)) {
		t.Fatalf("pause should land mid-file, got %d of %d", partial, len(blob))
	}

	// A second pause must be refused, not stacked.
	if _, err := m.Pause(item.ID); err != ErrBusy {
		t.Errorf("second Pause = %v, want ErrBusy", err)
	}

	resumed, err := m.Resume(item.ID)
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if resumed.Status != StatusRunning {
		t.Fatalf("status after resume = %q", resumed.Status)
	}

	done := waitStatus(t, m, item.ID, StatusDone)
	got, err := os.ReadFile(done.Path)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if !bytes.Equal(got, blob) {
		t.Fatalf("resumed file differs from the source (partial was %d bytes)", partial)
	}
}

func TestCancelDeletesThePartial(t *testing.T) {
	blob := make([]byte, 256<<10)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.WriteHeader(http.StatusOK)
			return
		}
		// Endless slow stream: the cancel must land while it runs.
		for i := 0; i < len(blob); i += 4096 {
			end := i + 4096
			if end > len(blob) {
				end = len(blob)
			}
			if _, err := w.Write(blob[i:end]); err != nil {
				return
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			time.Sleep(5 * time.Millisecond)
		}
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	item, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	time.Sleep(60 * time.Millisecond)

	gone, err := m.Cancel(item.ID)
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if gone.Status != StatusCancelled {
		t.Errorf("status after cancel = %q", gone.Status)
	}
	time.Sleep(80 * time.Millisecond) // writers exit on the cancelled ctx
	if _, err := os.Stat(gone.Path + ".part"); !os.IsNotExist(err) {
		t.Errorf(".part file survived the cancel")
	}
	if _, err := os.Stat(gone.Path + ".part.json"); !os.IsNotExist(err) {
		t.Errorf("sidecar survived the cancel")
	}
}

func TestDuplicateNamesGetANumber(t *testing.T) {
	blob := []byte("tiny")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.Header().Set("Content-Disposition", `attachment; filename="same.txt"`)
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(blob)
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	first, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start 1: %v", err)
	}
	waitStatus(t, m, first.ID, StatusDone)

	second, err := m.Start(srv.URL, "")
	if err != nil {
		t.Fatalf("Start 2: %v", err)
	}
	waitStatus(t, m, second.ID, StatusDone)

	if filepath.Base(first.Path) == filepath.Base(second.Path) {
		t.Fatalf("two downloads collided on %q", first.Path)
	}
	if !strings.Contains(second.Path, "(1)") {
		t.Errorf("second path %q should carry the (1) suffix", second.Path)
	}
}

func TestRejectsNonHTTPURLs(t *testing.T) {
	m := newTestManager(t, httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})))
	for _, raw := range []string{"", "ftp://example.com/x", "file:///C:/x", "javascript:alert(1)"} {
		if _, err := m.Start(raw, ""); err == nil {
			t.Errorf("Start(%q) should be refused", raw)
		}
	}
}

func TestErrorFromServerSurfacesOnTheItem(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)

	m := newTestManager(t, srv)
	if _, err := m.Start(srv.URL, ""); err == nil {
		t.Fatal("Start against a 403 should fail the probe, not queue a doomed row")
	}
}

func TestSplitSegmentsCoversEveryByteExactlyOnce(t *testing.T) {
	for _, tc := range []struct {
		total int64
		n     int
	}{
		{1000, 4}, // even split
		{1001, 4}, // uneven — the last segment absorbs the remainder
		{3, 8},    // fewer chunks than segments
		{1, 1},    // tiny file, one segment
		{0, 4},    // unknown size
	} {
		segs := splitSegments(tc.total, tc.n, tc.total > 0)
		var cursor int64
		for i, s := range segs {
			if s.start != cursor {
				t.Fatalf("total=%d n=%d: segment %d starts at %d, want %d",
					tc.total, tc.n, i, s.start, cursor)
			}
			if s.end < s.start && tc.total > 0 {
				t.Fatalf("total=%d n=%d: segment %d is empty", tc.total, tc.n, i)
			}
			cursor = s.end + 1
		}
		if tc.total > 0 && cursor != tc.total {
			t.Fatalf("total=%d n=%d: segments cover %d bytes", tc.total, tc.n, cursor)
		}
	}
}

func TestSanitizeFilename(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"normal.mp4", "normal.mp4"},
		{`a<b>c:d"e/f\g|h?i*.mp4`, "a_b_c_d_e_f_g_h_i_.mp4"},
		{"CON", "_CON"},
		{"con.mp4", "_con.mp4"},
		{"trailing...  ", "trailing"},
		{"", "download"},
		{"   ", "download"},
	} {
		if got := sanitizeFilename(tc.in); got != tc.want {
			t.Errorf("sanitizeFilename(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestFilenameFromDisposition(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", ""},
		{`attachment; filename="naam.mp4"`, "naam.mp4"},
		{`attachment; filename=naam.mp4`, "naam.mp4"},
		{`attachment; filename*=UTF-8''naam%20video.mp4`, "naam video.mp4"},
	} {
		if got := filenameFromDisposition(tc.in); got != tc.want {
			t.Errorf("filenameFromDisposition(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseContentRangeTotal(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"bytes 0-0/12345", "12345"},
		{"bytes 0-0/*", "0"},
		{"garbage", "0"},
		{"", "0"},
	} {
		if got := fmt.Sprint(parseContentRangeTotal(tc.in)); got != tc.want {
			t.Errorf("parseContentRangeTotal(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
