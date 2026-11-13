package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/lexicon"
	"github.com/engrtarun/T9EditorLIT/go/internal/postpass"
)

// call is the small helper every new-endpoint test uses: build the request,
// hand it to the same mux the daemon serves, and decode the answer.
func call(t *testing.T, s *Server, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("content-type", "application/json")
	}
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func TestMediaProbeRejectsMissingAndUnknownFiles(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)

	if rec := call(t, s, "POST", "/v1/media/probe", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty path = %d, want 400", rec.Code)
	}
	missing := filepath.Join(t.TempDir(), "nope.mp4")
	rec := call(t, s, "POST", "/v1/media/probe", `{"path":`+quote(missing)+`}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing file = %d, want 404", rec.Code)
	}
}

func TestMediaProbeReturnsIssuesForARealBrokenContainer(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skipf("ffprobe not available: %v", err)
	}
	// A text file with an .mp4 extension: ffprobe refuses it, and the gate
	// must answer with a probe_failed issue instead of a 500.
	path := filepath.Join(t.TempDir(), "not-really.mp4")
	if err := os.WriteFile(path, []byte("this is not a video"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServer(t, baseConfig(), nil)
	rec := call(t, s, "POST", "/v1/media/probe", `{"path":`+quote(path)+`}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var rep struct {
		Issues []struct {
			Code   string `json:"code"`
			Action string `json:"action"`
		} `json:"issues"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, i := range rep.Issues {
		if i.Code == "probe_failed" || i.Code == "no_audio" || i.Action == "remux" {
			found = true
		}
	}
	if !found {
		t.Fatalf("unreadable container produced no finding: %s", rec.Body.String())
	}
}

func TestMediaRemuxRejectsMissingFile(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)
	missing := filepath.Join(t.TempDir(), "nope.mp4")
	rec := call(t, s, "POST", "/v1/media/remux", `{"path":`+quote(missing)+`}`)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestLexiconRoundTrip(t *testing.T) {
	cfg := baseConfig()
	s, _ := newTestServer(t, cfg, nil)
	store, err := lexicon.Open(filepath.Join(t.TempDir(), "lexicon.json"))
	if err != nil {
		t.Fatalf("lexicon: %v", err)
	}
	s.deps.Lexicon = store

	rec := call(t, s, "PUT", "/v1/lexicon", `{"entries":[{"term":"UPI","aliases":["यू पी आई"]}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}

	rec = call(t, s, "GET", "/v1/lexicon", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("get = %d", rec.Code)
	}
	var got struct {
		Entries []postpass.Entry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Entries) != 1 || got.Entries[0].Term != "UPI" {
		t.Fatalf("round trip = %+v", got.Entries)
	}
}

func TestLexiconWithoutStoreIsUnavailableNotFatal(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)
	if rec := call(t, s, "GET", "/v1/lexicon", ""); rec.Code != http.StatusOK {
		t.Fatalf("list without store = %d, want 200", rec.Code)
	}
	rec := call(t, s, "PUT", "/v1/lexicon", `{"entries":[{"term":"X","aliases":[]}]}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("save without store = %d, want 503", rec.Code)
	}
}

func TestLexiconSaveSanitizesAndKeepsOrder(t *testing.T) {
	s, _ := newTestServer(t, baseConfig(), nil)
	store, err := lexicon.Open(filepath.Join(t.TempDir(), "lexicon.json"))
	if err != nil {
		t.Fatal(err)
	}
	s.deps.Lexicon = store

	rec := call(t, s, "PUT", "/v1/lexicon",
		`{"entries":[{"term":" RAG ","aliases":["रैग","रैग","rag"]},{"term":"rag","aliases":["dup"]}]}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	entries := store.List()
	if len(entries) != 1 || entries[0].Term != "RAG" {
		t.Fatalf("stored = %+v", entries)
	}
	if len(entries[0].Aliases) != 1 || entries[0].Aliases[0] != "रैग" {
		t.Fatalf("aliases = %+v", entries[0].Aliases)
	}
}

func quote(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}
