// Package cloud — merge_test.go: the Gemini reconciliation.
//
// The merge is an upgrade with a safety net, so its tests pin both halves:
// the parser's tolerance for real model output (code fences, preamble, bad
// numbers) and the clock algebra — chunk-relative in the prompt, absolute on
// the way out, with the primary's word timings reattached so a split still
// cuts text.
package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

func TestParseMergeLinesReadsFencedJSON(t *testing.T) {
	out := "Here is the reconciled transcript:\n```json\n" +
		`[{"start":0,"end":1.5,"text":"pehli line"},{"start":1.5,"end":2,"text":"doosri"}]` +
		"\n```\nHope that helps."

	lines, err := ParseMergeLines(out)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(lines) != 2 || lines[0].Text != "pehli line" || lines[1].End != 2 {
		t.Errorf("lines = %+v", lines)
	}
}

// TestParseMergeLinesCleansNumbers pins the sanity passes: blank text is
// dropped, a reversed window is swapped, a negative start is clamped, and the
// result is ordered by start time.
func TestParseMergeLinesCleansNumbers(t *testing.T) {
	lines, err := ParseMergeLines(`[
		{"start":5,"end":3,"text":"reversed"},
		{"start":-1,"end":1,"text":"negative"},
		{"start":0,"end":1,"text":"   "},
		{"start":0.5,"end":1.5,"text":"last"}
	]`)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3 (the blank one is gone)", len(lines))
	}
	if lines[0].Text != "negative" || lines[0].Start != 0 {
		t.Errorf("first = %+v, want the negative start clamped and ordered first", lines[0])
	}
	if lines[1].Text != "last" || lines[1].Start != 0.5 {
		t.Errorf("second = %+v, want ordered by start time", lines[1])
	}
	if lines[2].Text != "reversed" || lines[2].Start != 3 || lines[2].End != 5 {
		t.Errorf("third = %+v, want start/end swapped", lines[2])
	}
}

func TestParseMergeLinesRejectsUnusableAnswers(t *testing.T) {
	for _, out := range []string{"", "   ", "no array here", "[]", `{"start":0}`} {
		if _, err := ParseMergeLines(out); err == nil {
			t.Errorf("ParseMergeLines(%q) accepted an unusable answer", out)
		}
	}
}

func TestLinesFromSegmentsUsesTheChunkClock(t *testing.T) {
	segs := []model.Segment{
		{Text: "kept", StartSecs: 900.5, EndSecs: 902},
		{Text: "  ", StartSecs: 902, EndSecs: 903}, // blank lines never travel
	}
	lines := LinesFromSegments(segs, 900)

	if len(lines) != 1 {
		t.Fatalf("got %d lines, want 1", len(lines))
	}
	if lines[0].Start != 0.5 || lines[0].End != 2 {
		t.Errorf("line = %+v, want the 900s offset subtracted", lines[0])
	}
}

// stubGeminiMerge answers the generateContent call with `merged` as the
// model's text, JSON-encoded the way the real endpoint wraps it.
func stubGeminiMerge(t *testing.T, merged string, seen *[]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if seen != nil {
			*seen = append(*seen, r.URL.Path)
		}
		resp, err := json.Marshal(map[string]any{
			"candidates": []any{map[string]any{
				"content": map[string]any{
					"parts": []any{map[string]any{"text": merged}},
				},
			}},
		})
		if err != nil {
			t.Errorf("stub response: %v", err)
		}
		_, _ = w.Write(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// TestMergeChunkTranscriptsAddsOffsetBack runs one full reconciliation against
// a stub Gemini: both readings go in on the chunk clock, the answer comes out
// on the video's timeline, and the primary's word timings are reattached.
func TestMergeChunkTranscriptsAddsOffsetBack(t *testing.T) {
	srv := stubGeminiMerge(t, `[{"start":0.5,"end":1.5,"text":"best reading"}]`, nil)

	c := NewGemini("gk", "gemini-2.5-flash", srv.URL)
	primary := ChunkTranscript{Language: "hi", Segments: []model.Segment{{
		ID: "p", StartSecs: 900.4, EndSecs: 901.6, Text: "pri", Keep: true,
		Words: []model.Word{{Word: "pri", Start: 900.4, End: 901.6}},
	}}}
	secondary := ChunkTranscript{Segments: []model.Segment{{
		ID: "s", StartSecs: 900.6, EndSecs: 901.4, Text: "sec", Keep: true,
	}}}

	segs, err := c.MergeChunkTranscripts(context.Background(), 900, primary, secondary)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(segs) != 1 {
		t.Fatalf("got %d segments, want 1", len(segs))
	}
	s := segs[0]
	if s.Text != "best reading" {
		t.Errorf("text = %q", s.Text)
	}
	if s.StartSecs != 900.5 || s.EndSecs != 901.5 {
		t.Errorf("times = %f..%f, want the 900s offset added back", s.StartSecs, s.EndSecs)
	}
	if !s.Keep {
		t.Error("merged segments must default to keep")
	}
	if len(s.Words) != 1 || s.Words[0].Word != "pri" {
		t.Errorf("words = %+v, want the primary reading's word timings reattached", s.Words)
	}
}

// TestMergePromptNamesThePrimary: Gemini is told which reading to prefer on a
// tie. Swap the labels silently and the accuracy story quietly inverts.
func TestMergePromptNamesThePrimary(t *testing.T) {
	prompt := BuildMergePrompt(
		[]mergeLine{{Text: "primary line"}},
		[]mergeLine{{Text: "secondary line"}},
	)
	if strings.Count(prompt, "PRIMARY reading, prefer on ties") != 1 {
		t.Error("the prompt must tell Gemini the primary wins ties")
	}
	if strings.Count(prompt, "primary line") != 1 ||
		strings.Count(prompt, "secondary line") != 1 {
		t.Errorf("both readings must travel in the prompt:\n%s", prompt)
	}
}

// TestMergeRejectsDroppedContent: a merge that keeps far fewer words than the
// longer reading is rejected, so a Gemini answer that quietly dropped a
// sentence degrades to the primary transcript instead of shipping the gap.
func TestMergeRejectsDroppedContent(t *testing.T) {
	long := "one two three four five six seven eight nine ten eleven twelve"
	srv := stubGeminiMerge(t, `[{"start":0,"end":1,"text":"one two"}]`, nil)

	c := NewGemini("gk", "gemini-2.5-flash", srv.URL)
	primary := ChunkTranscript{Segments: []model.Segment{{Text: long, StartSecs: 0, EndSecs: 2}}}
	secondary := ChunkTranscript{Segments: []model.Segment{{Text: long, StartSecs: 0, EndSecs: 2}}}

	if _, err := c.MergeChunkTranscripts(context.Background(), 0, primary, secondary); err == nil {
		t.Fatal("expected an error for a merge that dropped most of the text")
	}
}

// TestMergeRejectsInventedContent: a merge that is notably longer than either
// reading (the model concatenated both) is rejected for the same reason.
func TestMergeRejectsInventedContent(t *testing.T) {
	long := "one two three four five six seven eight nine ten"
	srv := stubGeminiMerge(t, `[{"start":0,"end":2,"text":"one two three four five six seven eight nine ten one two three four five six seven eight nine ten"}]`, nil)

	c := NewGemini("gk", "gemini-2.5-flash", srv.URL)
	primary := ChunkTranscript{Segments: []model.Segment{{Text: long, StartSecs: 0, EndSecs: 2}}}
	secondary := ChunkTranscript{Segments: []model.Segment{{Text: long, StartSecs: 0, EndSecs: 2}}}

	if _, err := c.MergeChunkTranscripts(context.Background(), 0, primary, secondary); err == nil {
		t.Fatal("expected an error for a merge that invented content")
	}
}

// TestMergeClampsTimestampsAndOverlaps: a merge that slips past the prompt's
// rules gets clamped to the recording's span and de-overlapped, so the editor
// never receives a segment it cannot cut.
func TestMergeClampsTimestampsAndOverlaps(t *testing.T) {
	srv := stubGeminiMerge(t, `[{"start":0,"end":5,"text":"first line"},{"start":1,"end":2,"text":"second line"}]`, nil)

	c := NewGemini("gk", "gemini-2.5-flash", srv.URL)
	primary := ChunkTranscript{Segments: []model.Segment{{Text: "first line second line", StartSecs: 0, EndSecs: 2}}}
	secondary := ChunkTranscript{Segments: []model.Segment{{Text: "first line second line", StartSecs: 0, EndSecs: 2}}}

	segs, err := c.MergeChunkTranscripts(context.Background(), 0, primary, secondary)
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(segs) != 2 {
		t.Fatalf("got %d segments, want 2", len(segs))
	}
	if segs[0].EndSecs > 2.01 {
		t.Errorf("first segment end = %v, want clamped to the 2s span", segs[0].EndSecs)
	}
	if segs[1].StartSecs < segs[0].EndSecs-0.001 {
		t.Errorf("segments overlap: %+v / %+v", segs[0], segs[1])
	}
}
