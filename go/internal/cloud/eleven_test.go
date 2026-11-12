// Package cloud — eleven_test.go: the primary transcriber's contract.
//
// These tests stand in httptest servers for ElevenLabs and pin the three
// things a silent change would break: the request must carry the fields the
// provider needs (model, word granularity, no audio events, the key header),
// the reply's word list must become timed segments with the spacing and
// audio-event noise dropped, and a key-level failure must rotate to the next
// account inside the same chunk instead of failing it.
package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// stubEleven serves Scribe replies. The handler tells requests apart by the
// xi-api-key header, which is exactly how the provider does.
type stubEleven struct {
	mu     sync.Mutex
	calls  int
	server *httptest.Server
}

func newStubEleven(t *testing.T, handle func(w http.ResponseWriter, r *http.Request, call int)) *stubEleven {
	t.Helper()
	st := &stubEleven{}
	st.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		st.mu.Lock()
		st.calls++
		n := st.calls
		st.mu.Unlock()
		handle(w, r, n)
	}))
	t.Cleanup(st.server.Close)
	return st
}

func writeWords(w http.ResponseWriter, words string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"language_code":"hi","language_probability":0.98,"text":"","words":` + words + `}`))
}

const wordsHappy = `[
	{"text":"hello","type":"word","start":0,"end":1},
	{"text":" ","type":"spacing","start":1,"end":1.05},
	{"text":"world","type":"word","start":1.1,"end":2},
	{"text":"[laugh]","type":"audio_event","start":2.1,"end":2.5},
	{"text":"namaste","type":"word","start":2.2,"end":3}
]`

func testClient(st *stubEleven, keys ...string) *ElevenClient {
	return &ElevenClient{
		Model:  "scribe_v1",
		URL:    st.server.URL,
		SubURL: st.server.URL + "/sub",
		HTTP:   st.server.Client(),
		Pool:   NewKeyPool("", keys),
	}
}

// TestElevenSendsScribeFields pins the request shape. A missing
// timestamps_granularity=word silently destroys the editor's word-level
// cutting, and a missing language_code lets detection drift between chunks.
func TestElevenSendsScribeFields(t *testing.T) {
	var gotKey, gotModel, gotGran, gotEvents, gotLang string
	var gotFile bool
	st := newStubEleven(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		gotKey = r.Header.Get("xi-api-key")
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			t.Errorf("multipart: %v", err)
		}
		gotModel = r.FormValue("model_id")
		gotGran = r.FormValue("timestamps_granularity")
		gotEvents = r.FormValue("tag_audio_events")
		gotLang = r.FormValue("language_code")
		if _, _, err := r.FormFile("file"); err != nil {
			t.Errorf("file part: %v", err)
		} else {
			gotFile = true
		}
		writeWords(w, wordsHappy)
	})

	c := testClient(st, "KEY-1")
	ct, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 900, "hi", "")
	if err != nil {
		t.Fatalf("transcribe: %v", err)
	}

	if gotKey != "KEY-1" {
		t.Errorf("xi-api-key = %q", gotKey)
	}
	if gotModel != "scribe_v1" {
		t.Errorf("model_id = %q, want scribe_v1", gotModel)
	}
	if gotGran != "word" {
		t.Errorf("timestamps_granularity = %q, want word (word cutting depends on it)", gotGran)
	}
	if gotEvents != "false" {
		t.Errorf("tag_audio_events = %q, want false", gotEvents)
	}
	if gotLang != "hi" {
		t.Errorf("language_code = %q, want the pinned language", gotLang)
	}
	if !gotFile {
		t.Error("the chunk file never reached the request")
	}
	if len(ct.Segments) == 0 {
		t.Error("no segments came back")
	}
}

// TestElevenBuildsSegmentsFromWords pins the reply parsing: word timings are
// shifted onto the video's timeline, spacing and audio events are dropped,
// and close words share one line.
func TestElevenBuildsSegmentsFromWords(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		writeWords(w, wordsHappy)
	})

	c := testClient(st, "KEY-1")
	ct, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 900, "hi", "")
	if err != nil {
		t.Fatalf("transcribe: %v", err)
	}

	if ct.Language != "hi" {
		t.Errorf("language = %q, want hi", ct.Language)
	}
	if len(ct.Segments) != 1 {
		t.Fatalf("got %d segments, want 1 (all gaps are under the pause break)", len(ct.Segments))
	}
	seg := ct.Segments[0]
	if seg.Text != "hello world namaste" {
		t.Errorf("text = %q, want the words without the spacing or the [laugh]", seg.Text)
	}
	if seg.StartSecs != 900 || seg.EndSecs != 903 {
		t.Errorf("times = %f..%f, want the chunk offset of 900 applied", seg.StartSecs, seg.EndSecs)
	}
	if len(seg.Words) != 3 {
		t.Errorf("%d words attached, want 3", len(seg.Words))
	}
}

// TestElevenRotatesPastABadKey is the pool's headline behaviour: one account
// rejected with 401 must not fail the chunk while a sibling account is
// healthy — the client retries on the next key within the same call.
func TestElevenRotatesPastABadKey(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		if r.Header.Get("xi-api-key") == "KEY-DEAD" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"detail":{"status":"invalid_api_key","message":"bad key"}}`))
			return
		}
		writeWords(w, wordsHappy)
	})

	c := testClient(st, "KEY-DEAD", "KEY-LIVE")
	ct, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 0, "", "")
	if err != nil {
		t.Fatalf("transcribe: %v (a dead key must rotate to a live one)", err)
	}
	if len(ct.Segments) == 0 {
		t.Fatal("the live key's transcript is missing")
	}

	var dead, live KeyStatus
	for _, s := range c.Pool.Snapshot() {
		switch s.ID {
		case keyHash("KEY-DEAD"):
			dead = s
		case keyHash("KEY-LIVE"):
			live = s
		}
	}
	if dead.State != "disabled" {
		t.Errorf("dead key state = %q, want disabled", dead.State)
	}
	if live.State != "ready" || live.Uses != 1 {
		t.Errorf("live key = %q/%d uses, want ready/1", live.State, live.Uses)
	}
}

// TestElevenRotatesOn429: a rate-limited account is benched mid-chunk and the
// sibling carries the request.
func TestElevenRotatesOn429(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, _ *http.Request, call int) {
		if call == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"detail":{"status":"rate_limit","retry_after":30}}`))
			return
		}
		writeWords(w, wordsHappy)
	})

	c := testClient(st, "KEY-A", "KEY-B")
	if _, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 0, "", ""); err != nil {
		t.Fatalf("transcribe: %v (a 429 must rotate, not fail the chunk)", err)
	}

	cooled := 0
	for _, s := range c.Pool.Snapshot() {
		if s.State == "cooldown" {
			cooled++
		}
	}
	if cooled != 1 {
		t.Errorf("%d accounts cooling, want exactly the one that got 429'd", cooled)
	}
}

// TestElevenChunkErrorWithoutRotation: a 422 belongs to the CHUNK, not the
// account — every key would fail it identically, so the client must not burn
// sibling accounts (and their quota) on a doomed upload.
func TestElevenChunkErrorWithoutRotation(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"detail":{"message":"bad audio"}}`))
	})

	c := testClient(st, "KEY-A", "KEY-B")
	_, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 0, "", "")
	if err == nil {
		t.Fatal("a 422 must fail the chunk")
	}
	if got := st.Calls(); got != 1 {
		t.Errorf("%d upstream calls, want exactly 1 (no sibling burned on a chunk-level error)", got)
	}
}

func TestElevenEmptyPoolIsErrNoKeys(t *testing.T) {
	c := testClient(newStubEleven(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		t.Error("no request should leave the process without a key")
	}))

	if _, err := c.TranscribeChunkResult(context.Background(), writeChunkFile(t), 0, "", ""); err != ErrNoKeys {
		t.Fatalf("err = %v, want ErrNoKeys", err)
	}
}

// ── probe ────────────────────────────────────────────────────────────────

func TestElevenProbeReadsSubscription(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, r *http.Request, _ int) {
		if r.Method != http.MethodGet {
			t.Errorf("probe method = %s, want GET", r.Method)
		}
		if r.Header.Get("xi-api-key") != "KEY-1" {
			t.Errorf("probe key = %q", r.Header.Get("xi-api-key"))
		}
		_, _ = w.Write([]byte(`{"tier":"free","character_count":6200,"character_limit":10000,"next_character_count_reset_unix":1767139200}`))
	})

	c := testClient(st, "KEY-1")
	res := c.Probe(context.Background(), "KEY-1")
	if !res.OK {
		t.Fatalf("probe = %v, want ok", res.Detail)
	}
	if res.Tier != "free" || res.QuotaUsed != 6200 || res.QuotaLimit != 10000 {
		t.Errorf("quota snapshot = %s/%d/%d, want free/6200/10000", res.Tier, res.QuotaUsed, res.QuotaLimit)
	}
}

func TestElevenProbeRejectsBadKey(t *testing.T) {
	st := newStubEleven(t, func(w http.ResponseWriter, _ *http.Request, _ int) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{}`))
	})

	c := testClient(st, "KEY-1")
	res := c.Probe(context.Background(), "WRONG")
	if res.OK {
		t.Fatal("a 401 key must not probe ok")
	}
}

// TestParseRetryAfter covers the two shapes ElevenLabs actually sends plus
// the plain-body fallthrough, because a silent 0 would send a rate-limited
// account right back into rotation.
func TestParseRetryAfter(t *testing.T) {
	cases := []struct {
		body string
		want time.Duration
	}{
		{`{"detail":{"status":"rate_limit","retry_after":30}}`, 30 * time.Second},
		{`{"detail":{"retry_after_ms":1500}}`, 1500 * time.Millisecond},
		{`{"detail":{"message":"slow down"}}`, 0},
		{`not json`, 0},
	}
	for _, c := range cases {
		if got := parseRetryAfter(c.body); got != c.want {
			t.Errorf("parseRetryAfter(%s) = %s, want %s", c.body, got, c.want)
		}
	}
}

// Calls reports how many requests reached the stub.
func (st *stubEleven) Calls() int {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.calls
}

// writeChunkFile is the cloud package's counterpart of the api tests'
// writeChunk: a tiny file the multipart writer can stream.
func writeChunkFile(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "c0.m4a")
	if err := os.WriteFile(path, []byte("fake audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
