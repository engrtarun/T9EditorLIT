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

func TestGroqRequestsWordAndSegmentGranularities(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseMultipartForm(8 << 20); err != nil {
			t.Fatalf("ParseMultipartForm: %v", err)
		}
		got = r.MultipartForm.Value["timestamp_granularities[]"]
		_, _ = w.Write([]byte(`{"text":"","segments":[]}`))
	}))
	defer srv.Close()

	client := NewGroq("k", "m", "", srv.URL)
	if _, err := client.TranscribeChunk(context.Background(), writeChunk(t, "c.m4a"), 0, "", ""); err != nil {
		t.Fatalf("TranscribeChunk: %v", err)
	}

	// Both are required: `word` gives the editor word timings, `segment` gives
	// the confidence fields the no-speech guard reads.
	if len(got) != 2 || got[0] != "word" || got[1] != "segment" {
		t.Fatalf("timestamp_granularities = %v, want [word segment]", got)
	}
}

func TestGroqDropsNonSpeechSegments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"text": "Thank you. real words quiet mumble",
			"segments": [
				{"id":0,"start":0.0,"end":2.0,"text":"Thank you.","no_speech_prob":0.92,"avg_logprob":-1.4},
				{"id":1,"start":2.0,"end":4.0,"text":"real words","no_speech_prob":0.9,"avg_logprob":-0.2},
				{"id":2,"start":4.0,"end":6.0,"text":"quiet mumble","no_speech_prob":0.3,"avg_logprob":-1.6}
			]
		}`))
	}))
	defer srv.Close()

	client := NewGroq("k", "m", "", srv.URL)
	segments, err := client.TranscribeChunk(context.Background(), writeChunk(t, "c.m4a"), 0, "", "")
	if err != nil {
		t.Fatalf("TranscribeChunk: %v", err)
	}

	// Both signals must agree. High no_speech_prob with a confident
	// transcript is real quiet speech; low no_speech_prob with a poor
	// logprob is a hard-to-hear real line. Only the combination is a
	// hallucination.
	if len(segments) != 2 {
		t.Fatalf("got %d segments, want 2: %+v", len(segments), segments)
	}
	if segments[0].Text != "real words" || segments[1].Text != "quiet mumble" {
		t.Errorf("kept the wrong lines: %+v", segments)
	}
}

func TestGroqFilteredSegmentsDoNotFallBackToFlatWords(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// A music-only chunk: one confident-sounding hallucination, with the
		// same words repeated in the top-level list (the shape Groq returns
		// when only `word` granularity is honoured).
		_, _ = w.Write([]byte(`{
			"text": "Thank you.",
			"segments": [
				{"id":0,"start":0.0,"end":7.0,"text":"Thank you.","no_speech_prob":0.97,"avg_logprob":-1.8}
			],
			"words": [
				{"word":"Thank","start":0.2,"end":0.6},
				{"word":"you","start":0.7,"end":1.0}
			]
		}`))
	}))
	defer srv.Close()

	client := NewGroq("k", "m", "", srv.URL)
	segments, err := client.TranscribeChunk(context.Background(), writeChunk(t, "c.m4a"), 0, "", "")
	if err != nil {
		t.Fatalf("TranscribeChunk: %v", err)
	}
	if len(segments) != 0 {
		t.Fatalf("got %d segments, want 0 (filtered lines must not come back via the flat word list)", len(segments))
	}
}

func TestGroqAttachesTopLevelWordsToSegments(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"text": "thank you late",
			"segments": [
				{"id":0,"start":0.0,"end":1.2,"text":"thank you"},
				{"id":1,"start":3.0,"end":4.0,"text":"late"}
			],
			"words": [
				{"word":"thank","start":0.1,"end":0.4},
				{"word":"you","start":0.5,"end":0.9},
				{"word":"late","start":3.1,"end":3.5}
			]
		}`))
	}))
	defer srv.Close()

	client := NewGroq("k", "m", "", srv.URL)
	segments, err := client.TranscribeChunk(context.Background(), writeChunk(t, "c.m4a"), 0, "", "")
	if err != nil {
		t.Fatalf("TranscribeChunk: %v", err)
	}
	if len(segments) != 2 {
		t.Fatalf("got %d segments, want 2", len(segments))
	}
	if len(segments[0].Words) != 2 || segments[0].Words[0].Word != "thank" {
		t.Errorf("first line words = %+v", segments[0].Words)
	}
	if len(segments[1].Words) != 1 || segments[1].Words[0].Word != "late" {
		t.Errorf("second line words = %+v", segments[1].Words)
	}
}

func TestOnlyStockOutros(t *testing.T) {
	line := func(text string) model.Segment {
		return model.Segment{Text: text}
	}

	cases := []struct {
		name string
		in   []model.Segment
		want bool
	}{
		{"empty", nil, false},
		{"single thank you", []model.Segment{line("Thank you.")}, true},
		{"two stock phrases", []model.Segment{line("Thanks for watching!"), line("Please subscribe.")}, true},
		{"punctuation and case ignored", []model.Segment{line("  THANK   you!! ")}, true},
		{"real speech", []model.Segment{line("aaj hum baat karenge editing ke baare me")}, false},
		{"stock plus content", []model.Segment{line("Thank you."), line("ab shuru karte hain")}, false},
		{"long stock repetition is left alone", []model.Segment{
			line(strings.Repeat("thank you ", 20)),
		}, false},
		{"empty lines do not count as speech", []model.Segment{line("   "), line("Thank you.")}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := OnlyStockOutros(tc.in); got != tc.want {
				t.Errorf("OnlyStockOutros(%q) = %v, want %v", tc.name, got, tc.want)
			}
		})
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
