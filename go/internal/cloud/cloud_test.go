package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// ── Groq ────────────────────────────────────────────────────────────────

func TestGroqTranscribeChunkOffsetsTimestamps(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Fatalf("ParseMultipartForm: %v", err)
		}
		if got := r.FormValue("response_format"); got != "verbose_json" {
			t.Errorf("response_format = %q, want verbose_json (without it Groq returns no timings)", got)
		}
		if got := r.FormValue("model"); got != "whisper-large-v3" {
			t.Errorf("model = %q", got)
		}

		_, _ = w.Write([]byte(`{
			"text": "hello",
			"segments": [
				{"id":0,"start":0.0,"end":2.5,"text":"  pehla line  "},
				{"id":1,"start":2.5,"end":4.0,"text":"doosra line"},
				{"id":2,"start":4.0,"end":5.0,"text":"   "}
			]
		}`))
	}))
	defer srv.Close()

	chunk := writeChunk(t, "chunk0.m4a")

	client := NewGroq("test-key", "whisper-large-v3", "", srv.URL)
	segments, err := client.TranscribeChunk(context.Background(), chunk, 60.5, "", "")
	if err != nil {
		t.Fatalf("TranscribeChunk: %v", err)
	}

	if len(segments) != 2 {
		t.Fatalf("got %d segments, want 2 (blank segment should be dropped)", len(segments))
	}

	// Times must be shifted into the original video's timeline, not the chunk's.
	if segments[0].StartSecs != 60.5 {
		t.Errorf("StartSecs = %v, want 60.5 (chunk-local 0 + offset)", segments[0].StartSecs)
	}
	if segments[1].EndSecs != 64.5 {
		t.Errorf("EndSecs = %v, want 64.5", segments[1].EndSecs)
	}
	if segments[0].Text != "pehla line" {
		t.Errorf("Text = %q, want trimmed", segments[0].Text)
	}
	if !segments[0].Keep {
		t.Error("segments must default to keep")
	}
	if segments[0].Flag != model.FlagNone {
		t.Errorf("Flag = %q, want none", segments[0].Flag)
	}
}

func TestGroqErrorClassifiesRetryability(t *testing.T) {
	cases := []struct {
		status int
		want   bool
	}{
		{429, true},
		{500, true},
		{503, true},
		{400, false},
		{401, false},
		{413, false}, // chunk too large — retrying changes nothing
	}

	for _, tc := range cases {
		status := tc.status
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":"nope"}`))
		}))

		client := NewGroq("k", "m", "", srv.URL)
		_, err := client.TranscribeChunk(context.Background(), writeChunk(t, "c.m4a"), 0, "", "")
		srv.Close()

		if err == nil {
			t.Fatalf("status %d: expected an error", status)
		}
		if got := IsRetryable(err); got != tc.want {
			t.Errorf("status %d: retryable = %v, want %v", status, got, tc.want)
		}
	}
}

// ── Gemini ──────────────────────────────────────────────────────────────

func TestGeminiGenerateText(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-goog-api-key")
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"  hello  "}]}}]}`))
	}))
	defer srv.Close()

	client := NewGemini("gem-key", "gemini-2.5-flash", srv.URL)
	out, err := client.GenerateText(context.Background(), "hi")
	if err != nil {
		t.Fatalf("GenerateText: %v", err)
	}

	if out != "hello" {
		t.Errorf("output = %q, want trimmed 'hello'", out)
	}
	if !strings.Contains(gotPath, "gemini-2.5-flash:generateContent") {
		t.Errorf("path = %q", gotPath)
	}
	if gotKey != "gem-key" {
		t.Errorf("api key header = %q", gotKey)
	}
}

// ── Analysis parsing ────────────────────────────────────────────────────

func TestParseAnalysisStripsCodeFence(t *testing.T) {
	raw := "```json\n[{\"id\":\"a\",\"flag\":\"retake\",\"reason\":\"redid it\"}]\n```"

	got, err := ParseAnalysis(raw)
	if err != nil {
		t.Fatalf("ParseAnalysis: %v", err)
	}
	if len(got) != 1 || got[0].Flag != model.FlagRetake {
		t.Fatalf("got %+v", got)
	}
}

func TestParseAnalysisToleratesSurroundingProse(t *testing.T) {
	raw := "Sure! Here are the lines I flagged:\n[{\"id\":\"a\",\"flag\":\"silence\"}]\nHope that helps."

	got, err := ParseAnalysis(raw)
	if err != nil {
		t.Fatalf("ParseAnalysis: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d results, want 1", len(got))
	}
}

func TestParseAnalysisDropsInvalidFlags(t *testing.T) {
	raw := `[{"id":"a","flag":"vibes"},{"id":"","flag":"fumble"},{"id":"c","flag":"silence"}]`

	got, err := ParseAnalysis(raw)
	if err != nil {
		t.Fatalf("ParseAnalysis: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d results, want 1 (bad flag and empty id must be dropped)", len(got))
	}
	if got[0].ID != "c" {
		t.Errorf("kept the wrong row: %+v", got[0])
	}
}

func TestParseAnalysisEmptyArrayIsNotAnError(t *testing.T) {
	got, err := ParseAnalysis("[]")
	if err != nil {
		t.Fatalf("ParseAnalysis: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d, want 0", len(got))
	}
}

func TestParseAnalysisRejectsGarbage(t *testing.T) {
	// Must error rather than silently returning "nothing to cut" — the app has
	// to be able to tell a model failure apart from a clean transcript.
	if _, err := ParseAnalysis("I could not process this request."); err == nil {
		t.Fatal("expected an error for a non-JSON response")
	}
}

func TestApplyAnalysisMarksCuts(t *testing.T) {
	segments := []model.Segment{
		{ID: "1", Text: "intro", Keep: true},
		{ID: "2", Text: "botched take"},
		{ID: "3", Text: "corrected take"},
		{ID: "4", Text: "wrong example"},
	}

	out := ApplyAnalysis(segments, []Analysis{
		{ID: "2", Flag: model.FlagRetake, Reason: "redid the sentence"},
		{ID: "3", Flag: model.FlagNone},
		{ID: "4", Flag: model.FlagWrongExample},
	})

	if out[0].Keep != true || out[0].Flag != model.FlagNone {
		t.Errorf("unflagged line should stay kept: %+v", out[0])
	}
	if out[1].Keep != false || out[1].Flag != model.FlagRetake {
		t.Errorf("retake should be cut: %+v", out[1])
	}
	if out[1].Reason != "redid the sentence" {
		t.Errorf("reason not carried: %q", out[1].Reason)
	}
	if out[2].Keep != true {
		t.Errorf("corrected repeat must be KEPT: %+v", out[2])
	}
	if out[3].Keep != false || out[3].Flag != model.FlagWrongExample {
		t.Errorf("wrong example should be cut: %+v", out[3])
	}

	// Input must not be mutated.
	if segments[1].Keep {
		t.Error("ApplyAnalysis mutated its input")
	}
}

func writeChunk(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("fake audio bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
