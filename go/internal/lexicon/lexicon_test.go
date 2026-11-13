package lexicon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/postpass"
)

func tempPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "lexicon.json")
}

func TestOpenCreatesDefaults(t *testing.T) {
	path := tempPath(t)
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	got := s.List()
	if len(got) == 0 {
		t.Fatal("defaults empty")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file not created: %v", err)
	}
	// The measured case-39 failures must be in the starter set.
	joined := strings.ToLower(render(got))
	for _, want := range []string{"retrive argument document general", "चैनल जीपीटी", "एलएलएम"} {
		if !strings.Contains(joined, strings.ToLower(want)) {
			t.Errorf("default lexicon missing %q", want)
		}
	}
}

func TestReplacePersistsAndSurvivesReopen(t *testing.T) {
	path := tempPath(t)
	s, _ := Open(path)
	err := s.Replace([]postpass.Entry{
		{Term: "UPI", Aliases: []string{"यू पी आई", "upi"}},
		{Term: "EngrTarunDilwal", Aliases: []string{"engineer tarun dilwal"}},
	})
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	re, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := re.List()
	if len(got) != 2 || got[0].Term != "UPI" || got[1].Term != "EngrTarunDilwal" {
		t.Fatalf("reloaded = %+v", got)
	}
}

func TestReplaceSanitizes(t *testing.T) {
	path := tempPath(t)
	s, _ := Open(path)
	many := make([]string, 20)
	for i := range many {
		many[i] = "alias-" + string(rune('a'+i))
	}
	err := s.Replace([]postpass.Entry{
		{Term: "  RAG  ", Aliases: append(many, "rag", "  ")},
		{Term: "rag", Aliases: []string{"dup"}}, // duplicate term, dropped
		{Term: strings.Repeat("x", 100), Aliases: []string{"too long"}},
		{Term: "", Aliases: []string{"empty"}},
	})
	if err != nil {
		t.Fatalf("Replace: %v", err)
	}
	got := s.List()
	if len(got) != 1 {
		t.Fatalf("sanitized = %+v", got)
	}
	if got[0].Term != "RAG" {
		t.Fatalf("term not trimmed: %q", got[0].Term)
	}
	if len(got[0].Aliases) > MaxAliasesTerm {
		t.Fatalf("aliases = %d, max %d", len(got[0].Aliases), MaxAliasesTerm)
	}
	for _, a := range got[0].Aliases {
		if strings.EqualFold(a, "rag") || a == "" {
			t.Fatalf("bad alias survived: %q", a)
		}
	}
}

func TestCorruptFileFallsBackToDefaults(t *testing.T) {
	path := tempPath(t)
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := Open(path)
	if err == nil {
		t.Fatal("corrupt file must report an error")
	}
	if len(s.List()) == 0 {
		t.Fatal("corrupt file must still leave a usable vocabulary")
	}
}

func TestListIsACopy(t *testing.T) {
	path := tempPath(t)
	s, _ := Open(path)
	got := s.List()
	got[0].Aliases = append(got[0].Aliases, "mutated")
	again := s.List()
	for _, a := range again[0].Aliases {
		if a == "mutated" {
			t.Fatal("List leaked its internal slice")
		}
	}
}

func TestFileFormatIsReadable(t *testing.T) {
	path := tempPath(t)
	s, _ := Open(path)
	_ = s.Replace([]postpass.Entry{{Term: "API", Aliases: []string{"ए पी आई"}}})
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var f fileFormat
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("written file is not JSON: %v", err)
	}
	if f.Version != 1 || len(f.Entries) != 1 {
		t.Fatalf("file = %+v", f)
	}
}

func render(entries []postpass.Entry) string {
	var b strings.Builder
	for _, e := range entries {
		b.WriteString(e.Term)
		b.WriteString("|")
		b.WriteString(strings.Join(e.Aliases, "|"))
		b.WriteString("\n")
	}
	return b.String()
}
