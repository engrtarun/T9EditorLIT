package cloud

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// itoa keeps the stub above readable.
func itoa(i int) string { return strconv.Itoa(i) }

// stubChat serves a Groq chat completion whose content is fixed per test.
func stubChat(t *testing.T, reply string) *httptest.Server {
	t.Helper()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}

		// Read the body so a client that streams rather than buffers still
		// completes before the test tears the server down.
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
		}
		var sent chatRequest
		if err := json.Unmarshal(body, &sent); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if sent.Temperature != 0 {
			t.Errorf("Temperature = %v, want 0 (correction must be deterministic)", sent.Temperature)
		}

		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": reply},
			}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

// chatClient builds a client wired to the stub for both endpoints.
func chatClient(srv *httptest.Server) *GroqClient {
	c := NewGroq("test-key", "whisper-large-v3", "test-chat", srv.URL)
	c.ChatURL = srv.URL
	return c
}

func segs(texts ...string) []model.Segment {
	out := make([]model.Segment, len(texts))
	for i, t := range texts {
		out[i] = model.Segment{
			ID:        "1-" + string(rune('a'+i)),
			StartSecs: float64(i),
			EndSecs:   float64(i) + 1,
			Text:      t,
			Keep:      true,
		}
	}
	return out
}

func TestCorrectSegmentsFixesSpellingAndKeepsOriginal(t *testing.T) {
	srv := stubChat(t, `[
		{"i":0,"text":"JavaScript ek programming language hai."},
		{"i":1,"text":"Ab hum function define karte hain."}
	]`)

	in := segs("javas cript ek programing language hai", "ab hum funk shun define karte hain")
	out, err := chatClient(srv).CorrectSegments(context.Background(), in)
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}

	if out[0].Text != "JavaScript ek programming language hai." {
		t.Errorf("text = %q", out[0].Text)
	}
	if out[0].OriginalText != in[0].Text {
		t.Errorf("OriginalText = %q, want %q", out[0].OriginalText, in[0].Text)
	}
	if out[1].OriginalText == "" {
		t.Error("second line lost its original text")
	}

	// The input must be untouched: the caller still holds the raw Whisper
	// output and falls back to it if the UI rejects the corrections.
	if in[0].Text != "javas cript ek programing language hai" {
		t.Errorf("input was mutated: %q", in[0].Text)
	}

	// Timings and ids are not the model's business.
	if out[0].ID != in[0].ID || out[0].StartSecs != in[0].StartSecs || !out[0].Keep {
		t.Errorf("metadata changed: %+v", out[0])
	}
}

func TestCorrectSegmentsLeavesUnchangedLinesAlone(t *testing.T) {
	// A line the model could not improve must come back byte-for-byte, with
	// no OriginalText — otherwise the UI would claim to have "fixed" a line
	// it never touched.
	srv := stubChat(t, `[{"i":0,"text":"Ab hum function define karte hain."}]`)

	out, err := chatClient(srv).CorrectSegments(context.Background(),
		segs("Ab hum function define karte hain."))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out[0].OriginalText != "" {
		t.Errorf("OriginalText = %q, want empty for an unchanged line", out[0].OriginalText)
	}
	if out[0].Text != "Ab hum function define karte hain." {
		t.Errorf("text = %q", out[0].Text)
	}
}

func TestCorrectSegmentsIgnoresCaseOnlyChanges(t *testing.T) {
	srv := stubChat(t, `[{"i":0,"text":"ab hum loop likhte hain"}]`)

	out, err := chatClient(srv).CorrectSegments(context.Background(), segs("Ab hum loop likhte hain"))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out[0].OriginalText != "" {
		t.Errorf("OriginalText = %q; a case change is not worth showing as a fix", out[0].OriginalText)
	}
}

func TestCorrectSegmentsKeepsPunctuationButNotTheBadge(t *testing.T) {
	// The gain of a full stop is real, so the text must be updated — but the
	// line must not claim to be a "spelling fix", because the words are
	// identical. Otherwise the fix count is dominated by full stops.
	srv := stubChat(t, `[{"i":0,"text":"Ye sab theek hai."}]`)

	out, err := chatClient(srv).CorrectSegments(context.Background(), segs("ye sab theek hai"))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out[0].Text != "Ye sab theek hai." {
		t.Errorf("text = %q, want the corrected form applied", out[0].Text)
	}
	if out[0].OriginalText != "" {
		t.Errorf("OriginalText = %q, want empty for a punctuation-only change", out[0].OriginalText)
	}
}

func TestWorthReporting(t *testing.T) {
	cases := []struct {
		corrected, original string
		want                bool
	}{
		{"JavaScript ek language hai.", "javas cript ek language hai", true},
		{"Ye sab theek hai.", "ye sab theek hai", false},
		{"ab hum loop likhte hain", "Ab hum loop likhte hain", false},
		{"Same words", "same words", false},
		{`Array[0] mein hai`, "aray[0] mein hai", true},
		{"Loop likhte hain", "loop likhte hain,", false},
	}
	for _, c := range cases {
		if got := worthReporting(c.corrected, c.original); got != c.want {
			t.Errorf("worthReporting(%q, %q) = %v, want %v", c.corrected, c.original, got, c.want)
		}
	}
}

func TestCorrectSegmentsRejectsRunawayRewrite(t *testing.T) {
	// The model ignored "do not rewrite" and produced a paragraph. Far longer
	// than the source by any measure, so the whole thing is discarded.
	paraphrase := strings.Repeat("This is a very long explanatory sentence. ", 10)
	srv := stubChat(t, `[{"i":0,"text":"`+paraphrase+`"}]`)

	original := "chalo shuru karte hain"
	out, err := chatClient(srv).CorrectSegments(context.Background(), segs(original))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out[0].Text != original {
		t.Errorf("text = %q, want the original preserved", out[0].Text[:40])
	}
	if out[0].OriginalText != "" {
		t.Errorf("OriginalText = %q, want empty", out[0].OriginalText)
	}
}

func TestCorrectSegmentsDiscardsMisalignedResponse(t *testing.T) {
	// Two lines in, one out. Every index after the gap is now suspect, so
	// nothing from this reply is applied — including the line that happens to
	// be at index 0.
	srv := stubChat(t, `[{"i":0,"text":"JavaScript ek language hai."}]`)

	in := segs("javas cript ek language hai", "doosra line")
	out, err := chatClient(srv).CorrectSegments(context.Background(), in)
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	for i, s := range out {
		if s.Text != in[i].Text {
			t.Errorf("line %d was changed despite the count mismatch: %q", i, s.Text)
		}
	}
}

func TestCorrectSegmentsSurvivesOneFailedBatch(t *testing.T) {
	// 30 lines per batch, so 40 lines means two batches — 30 and 10. The first
	// fails; the second must still be corrected.
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}

		// Answer with exactly as many corrections as the batch had lines —
		// a short answer would be discarded as misaligned, which is the point
		// of the other test.
		body, _ := io.ReadAll(r.Body)
		var sent chatRequest
		_ = json.Unmarshal(body, &sent)

		n := 0
		if len(sent.Messages) > 0 {
			n = len(strings.Split(strings.TrimRight(sent.Messages[len(sent.Messages)-1].Content, "\n"), "\n")) - 1
		}
		items := make([]string, n)
		for i := range items {
			items[i] = `{"i":` + itoa(i) + `,"text":"fixed"}`
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": "[" + strings.Join(items, ",") + "]"},
			}},
		})
	}))
	defer srv.Close()

	var in []model.Segment
	for i := 0; i < 40; i++ {
		in = append(in, model.Segment{ID: "x", Text: "javas cript", Keep: true})
	}

	out, err := chatClient(srv).CorrectSegments(context.Background(), in)
	if err == nil {
		t.Fatal("expected an error describing the failed batch")
	}
	if !strings.Contains(err.Error(), "1 of 2 batches failed") {
		t.Errorf("err = %v, want it to name the failed batch count", err)
	}

	// The whole slice is still returned, and the healthy batch is corrected.
	if len(out) != len(in) {
		t.Fatalf("len(out) = %d, want %d", len(out), len(in))
	}
	if out[0].Text != "javas cript" {
		t.Errorf("line 0 = %q, want the raw Whisper text", out[0].Text)
	}
	if out[CorrectionBatchSize].Text != "fixed" {
		t.Errorf("line %d = %q, want the second batch corrected", CorrectionBatchSize, out[CorrectionBatchSize].Text)
	}
}

func TestCorrectSegmentsShortLineStillGetsABound(t *testing.T) {
	// A one-word source must not multiply out to a zero-byte limit, which
	// would reject every correction and leave short lines permanently
	// uncorrected.
	srv := stubChat(t, `[{"i":0,"text":"chalo"}]`)

	out, err := chatClient(srv).CorrectSegments(context.Background(), segs("chalo"))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out[0].Text != "chalo" {
		t.Errorf("text = %q", out[0].Text)
	}

	// But the bound still bites: this line grew 24x.
	srv2 := stubChat(t, `[{"i":0,"text":"chalo shuru karte hain ek naya paragraph"}]`)
	out2, err := chatClient(srv2).CorrectSegments(context.Background(), segs("chalo"))
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if out2[0].Text != "chalo" {
		t.Errorf("text = %q, want the runaway rewrite rejected", out2[0].Text)
	}
}

func TestCorrectSegmentsEmptyInput(t *testing.T) {
	srv := stubChat(t, "[]")

	out, err := chatClient(srv).CorrectSegments(context.Background(), nil)
	if err != nil {
		t.Fatalf("CorrectSegments: %v", err)
	}
	if len(out) != 0 {
		t.Errorf("len(out) = %d, want 0", len(out))
	}
}

func TestChatRequiresConfiguredModel(t *testing.T) {
	c := NewGroq("k", "whisper-large-v3", "", "")
	if _, err := c.Chat(context.Background(), "sys", "user"); err == nil {
		t.Fatal("expected an error when no chat model is configured")
	}
}

func TestChatRejectsEmptyCompletion(t *testing.T) {
	srv := stubChat(t, "")

	if _, err := chatClient(srv).Chat(context.Background(), "sys", "user"); err == nil {
		t.Fatal("expected an error for an empty completion")
	}
}

func TestChatSurfacesErrorInside200Body(t *testing.T) {
	// Groq reports some failures in the body with a 200 status. Reading that
	// as "no choices" would hide the real reason.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"error":{"message":"model is decommissioned"}}`))
	}))
	defer srv.Close()

	_, err := chatClient(srv).Chat(context.Background(), "sys", "user")
	if err == nil || !strings.Contains(err.Error(), "decommissioned") {
		t.Fatalf("err = %v, want the provider's own message", err)
	}
}

func TestParseCorrectionsStripsFenceAndPreamble(t *testing.T) {
	raw := "Sure, here you go:\n```json\n[{\"i\":0,\"text\":\"fixed\"}]\n```\nHope that helps."

	got, err := ParseCorrections(raw)
	if err != nil {
		t.Fatalf("ParseCorrections: %v", err)
	}
	if len(got) != 1 || got[0].Text != "fixed" {
		t.Errorf("got %+v", got)
	}
}

func TestParseCorrectionsRejectsNonJSON(t *testing.T) {
	// "No changes needed" must not parse as "nothing to correct" — the caller
	// needs to tell a broken response apart from a clean one.
	if _, err := ParseCorrections("No changes needed."); err == nil {
		t.Fatal("expected an error for a response with no JSON array")
	}
}
