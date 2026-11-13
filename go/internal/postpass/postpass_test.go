package postpass

import (
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

func seg(id string, start, end float64, text string) model.Segment {
	return model.Segment{ID: id, StartSecs: start, EndSecs: end, Text: text, Keep: true}
}

func TestBracketTagsBecomeDataNotNoise(t *testing.T) {
	s := seg("a", 0, 2, "[Music] intro (applause) and (2024) notes [संगीत]")
	tags := Tags(s.Text)
	want := []string{"music", "applause", "संगीत"}
	if len(tags) != len(want) {
		t.Fatalf("tags = %v, want %v", tags, want)
	}
	for i := range want {
		if tags[i] != want[i] {
			t.Fatalf("tags = %v, want %v", tags, want)
		}
	}
	// Unknown parentheses are content, not a sound effect.
	if strings.Contains(strings.Join(Tags("see (chapter 3)"), ","), "chapter") {
		t.Fatal("ordinary parentheses must not become a tag")
	}
	if got := VisibleText(s.Text, tags); got != "♪ intro 👏 and (2024) notes 🔊" {
		t.Fatalf("visible text = %q", got)
	}
}

func TestApplyBracketsCountsLines(t *testing.T) {
	segs := []model.Segment{
		seg("a", 0, 1, "[Music]"),
		seg("b", 1, 2, "hello"),
		seg("c", 2, 3, "(applause)"),
	}
	if n := ApplyBrackets(segs); n != 2 {
		t.Fatalf("tagged lines = %d, want 2", n)
	}
	if len(segs[1].Tags) != 0 || len(segs[0].Tags) != 1 {
		t.Fatalf("tags attached wrong: %+v", segs)
	}
	// Text must survive byte-for-byte.
	if segs[0].Text != "[Music]" {
		t.Fatalf("text was rewritten: %q", segs[0].Text)
	}
}

func TestCollapseLoopsKeepsOneRepresentative(t *testing.T) {
	segs := []model.Segment{
		seg("a", 100, 101, "Thank you for watching."),
		seg("b", 106, 107, "Thank you for watching."),
		seg("c", 112, 113, "thank you for watching"),
		seg("d", 118, 119, "Thank you for watching!"),
	}
	n := CollapseLoops(segs)
	if n != 3 {
		t.Fatalf("collapsed = %d, want 3", n)
	}
	if segs[0].RepeatCount != 4 || segs[0].RepeatKind != "loop" {
		t.Fatalf("representative = %+v", segs[0])
	}
	for i := 1; i < 4; i++ {
		if !segs[i].Repeated || segs[i].Keep || segs[i].RepeatOf != "a" {
			t.Fatalf("duplicate %d not marked: %+v", i, segs[i])
		}
	}
}

func TestCollapseLoopsLeavesTwoRealLinesAlone(t *testing.T) {
	segs := []model.Segment{
		seg("a", 0, 1, "नमस्ते दोस्तों"),
		seg("b", 1.2, 2, "नमस्ते दोस्तों"),
	}
	if n := CollapseLoops(segs); n != 0 {
		t.Fatalf("two close real lines collapsed: %d", n)
	}
}

func TestRetakeIsSuggestionNotDeletion(t *testing.T) {
	segs := []model.Segment{
		seg("a", 0, 1, "I mean"),
		seg("b", 1.2, 3, "I mean the third option"),
	}
	n := FlagRetakes(segs)
	if n == 0 {
		t.Fatal("retake not found")
	}
	if segs[0].RepeatKind != "fumble" || !segs[0].NeedsConfirm {
		t.Fatalf("first line = %+v", segs[0])
	}
	if !segs[0].Keep || segs[0].Flag != model.FlagFumble {
		t.Fatalf("retake must not be auto-cut: %+v", segs[0])
	}
	if segs[1].RepeatKind != "restatement" || !segs[1].Keep {
		t.Fatalf("completed line = %+v", segs[1])
	}
	if segs[1].Flag != model.FlagRetake {
		t.Fatalf("completed line flag = %q", segs[1].Flag)
	}
}

func TestInLineStutterFound(t *testing.T) {
	segs := []model.Segment{seg("a", 0, 3, "I mean I mean the third option")}
	if n := FlagRetakes(segs); n != 1 {
		t.Fatalf("stutter = %d, want 1", n)
	}
	if segs[0].RepeatKind != "stutter" || !segs[0].NeedsConfirm || !segs[0].Keep {
		t.Fatalf("stutter must only be a suggestion: %+v", segs[0])
	}
}

func TestCrosstalkMarksBothAndProtectsThem(t *testing.T) {
	segs := []model.Segment{
		{
			ID: "host", StartSecs: 0, EndSecs: 4, Keep: true, Text: "so the first thing",
			Words: []model.Word{{Word: "so", Start: 1.0, End: 1.3}, {Word: "first", Start: 1.3, End: 1.8}},
		},
		{
			ID: "guest", StartSecs: 1.4, EndSecs: 5, Keep: true, Text: "wait can I add",
			Words: []model.Word{{Word: "wait", Start: 1.5, End: 1.9}, {Word: "add", Start: 2.0, End: 2.3}},
		},
		seg("later", 8, 9, "normal line"),
	}
	n := MarkCrosstalk(segs)
	if n == 0 {
		t.Fatal("overlap not found")
	}
	if !segs[0].Crosstalk || !segs[1].Crosstalk {
		t.Fatalf("both speakers must be marked: %+v %+v", segs[0], segs[1])
	}
	if !segs[0].Keep || !segs[1].Keep || !segs[0].NeedsConfirm {
		t.Fatal("crosstalk must never be auto-cut")
	}
	if segs[2].Crosstalk {
		t.Fatal("non-overlapping line marked")
	}
}

func TestLexiconFixesKnownPhonetics(t *testing.T) {
	segs := []model.Segment{
		seg("a", 0, 1, "RAG ko retrive argument document general bolte hain"),
		seg("b", 1, 2, "चैनल जीपीटी aur एलएलएम"),
		seg("c", 2, 3, "rapid api response"),
	}
	entries := []Entry{
		{Term: "RAG", Aliases: []string{"retrive argument document general"}},
		{Term: "ChatGPT", Aliases: []string{"चैनल जीपीटी"}},
		{Term: "LLM", Aliases: []string{"एलएलएम"}},
	}
	n := ApplyLexicon(segs, entries)
	if n != 2 {
		t.Logf("a=%q\nb=%q\nc=%q", segs[0].Text, segs[1].Text, segs[2].Text)
		t.Fatalf("changed = %d, want 2", n)
	}
	if segs[0].Text != "RAG ko RAG bolte hain" {
		// Alias text contained "RAG" already; the alias should still match.
		t.Fatalf("line a = %q", segs[0].Text)
	}
	if segs[0].OriginalText != "RAG ko retrive argument document general bolte hain" {
		t.Fatalf("original lost: %q", segs[0].OriginalText)
	}
	if segs[1].Text != "ChatGPT aur LLM" {
		t.Fatalf("line b = %q", segs[1].Text)
	}
	// An alias that only occurs inside a longer word must not rewrite it.
	if segs[2].Text != "rapid api response" {
		t.Fatalf("boundary broken: %q", segs[2].Text)
	}
}

func TestLexiconRespectsWordBoundaries(t *testing.T) {
	if out, ok := replaceInsensitive("rapid response", "api", "API"); ok || out != "rapid response" {
		t.Fatalf("rewrote inside a word: %q ok=%v", out, ok)
	}
	out, ok := replaceInsensitive("the api is slow", "api", "API")
	if !ok || out != "the API is slow" {
		t.Fatalf("whole-word replace failed: %q ok=%v", out, ok)
	}
	// Devanagari has no case and no ASCII boundary; the plain match applies.
	out, ok = replaceInsensitive("चैनल जीपीटी kya hai", "चैनल जीपीटी", "ChatGPT")
	if !ok || out != "ChatGPT kya hai" {
		t.Fatalf("devanagari replace failed: %q ok=%v", out, ok)
	}
}

func TestLexiconDoesNotStackOriginal(t *testing.T) {
	segs := []model.Segment{{
		ID: "a", StartSecs: 0, EndSecs: 1, Keep: true,
		Text:         "AI se kaam",
		OriginalText: "eh ai se kaam",
	}}
	ApplyLexicon(segs, []Entry{{Term: "AI", Aliases: []string{"eh ai"}}})
	if segs[0].OriginalText != "eh ai se kaam" {
		t.Fatalf("existing original overwritten: %q", segs[0].OriginalText)
	}
	if segs[0].Text != "AI se kaam" {
		t.Fatalf("text = %q", segs[0].Text)
	}
}

func TestProcessRunsEveryPass(t *testing.T) {
	segs := []model.Segment{
		seg("a", 0, 2, "[Music] intro"),
		seg("b", 3, 4, "hello"),
		seg("c", 5, 6, "hello"),
		seg("d", 7, 8, "hello"),
	}
	res := Process(segs, []Entry{{Term: "API", Aliases: []string{"aapi"}}})
	if res.Tags != 1 {
		t.Errorf("tags = %d", res.Tags)
	}
	if res.Loops != 2 {
		t.Errorf("loops = %d, want 2", res.Loops)
	}
	if segs[1].Repeated || !segs[2].Repeated || !segs[3].Repeated {
		t.Errorf("loop marks wrong: %+v", segs)
	}
	if segs[1].RepeatCount != 3 {
		t.Errorf("representative count = %d, want 3", segs[1].RepeatCount)
	}
}
