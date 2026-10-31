package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/dl"
)

// newDLServer builds a server whose DL manager points at a temp dir and a
// stub file host.
func newDLServer(t *testing.T, blob []byte) (*Server, *httptest.Server) {
	t.Helper()

	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", fmt.Sprint(len(blob)))
			w.Header().Set("Content-Disposition", `attachment; filename="stub.bin"`)
			w.WriteHeader(http.StatusOK)
			return
		}
		// Serve ranged or whole, quickly.
		start, end := int64(0), int64(len(blob)-1)
		if rng := r.Header.Get("Range"); rng != "" {
			var s, e int64
			if _, err := fmt.Sscanf(rng, "bytes=%d-%d", &s, &e); err == nil {
				start, end = s, e
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(blob)))
				w.WriteHeader(http.StatusPartialContent)
			}
		}
		_, _ = w.Write(blob[start : end+1])
	}))
	t.Cleanup(site.Close)

	mgr, err := dl.New(dl.Options{
		Dir:             t.TempDir(),
		Log:             slog.New(slog.NewTextHandler(io.Discard, nil)),
		Segments:        2,
		MinSegmentBytes: 1 << 10,
		Client:          site.Client(),
	})
	if err != nil {
		t.Fatalf("dl.New: %v", err)
	}
	t.Cleanup(mgr.Shutdown)

	s := &Server{
		deps: Deps{
			DL:  mgr,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		},
		mux:        http.NewServeMux(),
		faviconDir: t.TempDir(),
	}
	// Register the routes so PathValue works in the tests (direct handler
	// calls bypass the mux and leave {id}/{action} empty).
	s.mux.HandleFunc("GET /v1/dl", s.handleDLList)
	s.mux.HandleFunc("POST /v1/dl", s.handleDLStart)
	s.mux.HandleFunc("POST /v1/dl/{id}/{action}", s.handleDLAction)
	return s, site
}

func TestDLStartListPauseResumeCancel(t *testing.T) {
	blob := bytes.Repeat([]byte("contract-lock!"), 4096) // ~56 KiB
	s, site := newDLServer(t, blob)

	// Start: must return an accepted item with the right shape.
	startRec := httptest.NewRecorder()
	startReq := httptest.NewRequest("POST", "/v1/dl",
		bytes.NewReader(mustJSON(t, map[string]string{"url": site.URL + "/stub.bin"})))
	s.handleDLStart(startRec, startReq)

	if startRec.Code != http.StatusAccepted {
		t.Fatalf("start status = %d, want 202; body %s", startRec.Code, startRec.Body.String())
	}

	var item dl.Item
	if err := json.Unmarshal(startRec.Body.Bytes(), &item); err != nil {
		t.Fatalf("unmarshal start response: %v", err)
	}
	// The camelCase contract the frontend mirrors.
	for _, key := range []string{"id", "url", "filename", "path",
		"totalBytes", "receivedBytes", "speedBps", "segments", "status"} {
		if !bytes.Contains(startRec.Body.Bytes(), []byte(`"`+key+`"`)) {
			t.Errorf("start response missing key %q: %s", key, startRec.Body.String())
		}
	}
	if item.Status != dl.StatusRunning {
		t.Errorf("start status = %q, want running", item.Status)
	}

	// List: the row must appear.
	listRec := httptest.NewRecorder()
	s.handleDLList(listRec, httptest.NewRequest("GET", "/v1/dl", nil))
	var list []dl.Item
	if err := json.Unmarshal(listRec.Body.Bytes(), &list); err != nil {
		t.Fatalf("unmarshal list: %v", err)
	}
	found := false
	for _, it := range list {
		if it.ID == item.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("started item not in list: %v", list)
	}

	// Pause: must be accepted.
	pauseRec := httptest.NewRecorder()
	pauseReq := httptest.NewRequest("POST", "/v1/dl/"+item.ID+"/pause", nil)
	s.mux.ServeHTTP(pauseRec, pauseReq)
	if pauseRec.Code != http.StatusOK && pauseRec.Code != http.StatusConflict {
		t.Errorf("pause status = %d, want 200 or 409; body %s",
			pauseRec.Code, pauseRec.Body.String())
	}

	// Unknown action: 400.
	badRec := httptest.NewRecorder()
	badReq := httptest.NewRequest("POST", "/v1/dl/"+item.ID+"/explode", nil)
	s.mux.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Errorf("unknown action status = %d, want 400", badRec.Code)
	}

	// Unknown id: 404.
	notFoundRec := httptest.NewRecorder()
	notFoundReq := httptest.NewRequest("POST", "/v1/dl/no-such-id/cancel", nil)
	s.mux.ServeHTTP(notFoundRec, notFoundReq)
	if notFoundRec.Code != http.StatusNotFound {
		t.Errorf("unknown id status = %d, want 404", notFoundRec.Code)
	}

	// Cancel: must be accepted (or conflict if already terminal).
	cancelRec := httptest.NewRecorder()
	cancelReq := httptest.NewRequest("POST", "/v1/dl/"+item.ID+"/cancel", nil)
	s.mux.ServeHTTP(cancelRec, cancelReq)
	if cancelRec.Code != http.StatusOK && cancelRec.Code != http.StatusConflict {
		t.Errorf("cancel status = %d, want 200 or 409; body %s",
			cancelRec.Code, cancelRec.Body.String())
	}
}

func TestDLStartRejectsBadURL(t *testing.T) {
	s, _ := newDLServer(t, []byte("x"))

	for _, raw := range []string{"", "ftp://x", "not-a-url"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("POST", "/v1/dl",
			bytes.NewReader(mustJSON(t, map[string]string{"url": raw})))
		s.handleDLStart(rec, req)
		if rec.Code != http.StatusBadGateway && rec.Code != http.StatusBadRequest {
			t.Errorf("url %q: status = %d, want 4xx/5xx", raw, rec.Code)
		}
	}
}

func TestDLStartMalformedBody(t *testing.T) {
	s, _ := newDLServer(t, []byte("x"))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/dl", bytes.NewReader([]byte("{not json")))
	s.handleDLStart(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("malformed body status = %d, want 400", rec.Code)
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	return b
}
