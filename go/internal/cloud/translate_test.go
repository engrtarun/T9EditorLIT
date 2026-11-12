package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// translationServer answers every request with the given JSON array, wrapped
// in the envelope the Gemini client expects.
func translationServer(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload := `{"candidates":[{"content":{"parts":[{"text":` + mustJSON(body) + `}]}}]}`
		_, _ = w.Write([]byte(payload))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// mustJSON quotes a raw string as a JSON string.
func mustJSON(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// The whole point of the pass: the source text survives untouched.
func TestTranslationNeverReplacesTheSourceText(t *testing.T) {
	srv := translationServer(t, `[{"i":0,"text":"today we talk about RAG"},{"i":1,"text":"we look at vector search"}]`)

	client := &GeminiClient{APIKey: "k", Model: "m", BaseURL: srv.URL, HTTP: srv.Client()}
	segments := []model.Segment{
		{ID: "a", Text: "आज हम RAG के बारे में बात करेंगे"},
		{ID: "b", Text: "वेक्टर सर्च देखते हैं"},
	}

	out, err := client.TranslateSegments(context.Background(), segments, "en")
	if err != nil {
		t.Fatalf("translate: %v", err)
	}

	if out[0].Text != segments[0].Text {
		t.Errorf("source text changed: %q", out[0].Text)
	}
	if out[0].TranslatedText != "today we talk about RAG" {
		t.Errorf("translated text = %q", out[0].TranslatedText)
	}
	if out[0].TranslationSource != "gemini" {
		t.Errorf("translation source = %q, want gemini", out[0].TranslationSource)
	}
	if out[1].TranslatedText != "we look at vector search" {
		t.Errorf("translated text = %q", out[1].TranslatedText)
	}
}

// The input slice must not be mutated: the caller still holds the source.
func TestTranslationLeavesTheInputAlone(t *testing.T) {
	srv := translationServer(t, `[{"i":0,"text":"hello"}]`)

	client := &GeminiClient{APIKey: "k", Model: "m", BaseURL: srv.URL, HTTP: srv.Client()}
	segments := []model.Segment{{ID: "a", Text: "नमस्ते"}}

	if _, err := client.TranslateSegments(context.Background(), segments, "en"); err != nil {
		t.Fatalf("translate: %v", err)
	}
	if segments[0].TranslatedText != "" {
		t.Error("the input segment was modified")
	}
}

// A reply that does not line up is refused. Shifting a translation by one
// would put the wrong words under the wrong line, which is worse than no
// translation at all.
func TestAMisalignedReplyIsRefused(t *testing.T) {
	srv := translationServer(t, `[{"i":0,"text":"one"},{"i":5,"text":"six"}]`)

	client := &GeminiClient{APIKey: "k", Model: "m", BaseURL: srv.URL, HTTP: srv.Client()}
	segments := []model.Segment{{ID: "a", Text: "one"}, {ID: "b", Text: "two"}}

	out, err := client.TranslateSegments(context.Background(), segments, "en")
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	for i, s := range out {
		if s.TranslatedText != "" {
			t.Errorf("line %d was translated to %q, want no translation at all", i, s.TranslatedText)
		}
	}
}

// A batch the model could not translate keeps its source text, and the rest
// of the transcript is still translated.
func TestAFailedBatchKeepsTheRestOfTheTranscript(t *testing.T) {
	// The first batch answers for every one of its lines; the second batch
	// fails outright.
	firstBatch := make([]string, 0, TranslationBatchSize)
	for i := 0; i < TranslationBatchSize; i++ {
		firstBatch = append(firstBatch, `{"i":`+strconv.Itoa(i)+`,"text":"translated"}`)
	}
	firstReply := "[" + strings.Join(firstBatch, ",") + "]"

	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		if calls == 1 {
			payload := `{"candidates":[{"content":{"parts":[{"text":` + mustJSON(firstReply) + `}]}}]}`
			_, _ = w.Write([]byte(payload))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	client := &GeminiClient{APIKey: "k", Model: "m", BaseURL: srv.URL, HTTP: srv.Client()}
	segments := make([]model.Segment, TranslationBatchSize+1)
	for i := range segments {
		segments[i] = model.Segment{ID: "x", Text: "line"}
	}

	out, err := client.TranslateSegments(context.Background(), segments, "en")
	if err == nil {
		t.Error("a failed batch must be reported")
	}
	if out[0].TranslatedText != "translated" {
		t.Errorf("the first batch was lost: %q", out[0].TranslatedText)
	}
	if out[len(out)-1].TranslatedText != "" {
		t.Error("the failed batch must keep its source text")
	}
}

// A code fence must not stop the parse.
func TestTranslationsSurviveACodeFence(t *testing.T) {
	raw := "```json\n[{\"i\":0,\"text\":\"hello\"}]\n```"

	got, err := ParseTranslations(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(got) != 1 || got[0].Text != "hello" {
		t.Errorf("parsed = %+v", got)
	}
}

// No array at all is an error, not an empty result.
func TestTranslationsWithoutAnArrayAreAnError(t *testing.T) {
	if _, err := ParseTranslations("I could not translate that."); err == nil {
		t.Error("a reply without a JSON array must be an error")
	}
}

// The prompt has to name the target language and ask for the source to stay
// put. A translator that paraphrases is worse than none.
func TestThePromptPinsTheTargetAndTheMeaning(t *testing.T) {
	if !strings.Contains(TranslatePrompt, "%s") {
		t.Error("the prompt must take the target language as a parameter")
	}
	if !strings.Contains(TranslatePrompt, "unchanged") {
		t.Error("the prompt must tell the model to leave lines alone when it cannot translate")
	}
}
