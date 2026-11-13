// Package lexicon persists the creator's vocabulary: the words a channel says
// every episode and Whisper spells differently every time.
//
// The playbook's case 39 measured the failure precisely - "RAG" came back as
// "Retrive Argument Document General", "ChatGPT" as "चैनल जीपीटी" - and the
// fix is not a better model, it is memory. One term learned once applies to
// every later video for free.
//
// The file is small JSON on purpose. It is read once per transcription and
// written only when the user edits it; there is no database dependency, no
// migration and no network.
package lexicon

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/engrtarun/T9EditorLIT/go/internal/postpass"
)

// Limits keep a pasted JSON file from becoming an unbounded prompt.
const (
	MaxEntries     = 200
	MaxAliasesTerm = 12
	MaxTermRunes   = 60
	MaxAliasRunes  = 80
)

// Store is a concurrency-safe view of the lexicon file.
type Store struct {
	mu      sync.RWMutex
	path    string
	entries []postpass.Entry
}

type fileFormat struct {
	Version int              `json:"version"`
	Entries []postpass.Entry `json:"entries"`
	Note    string           `json:"note,omitempty"`
}

// Open loads the lexicon at path, creating the default one if the file does
// not exist yet. A corrupt file is not fatal: the store starts empty and the
// error is returned so the daemon can log it, because losing the vocabulary
// is annoying but losing transcription because of it would be worse.
func Open(path string) (*Store, error) {
	s := &Store{path: path}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		s.entries = Default()
		if werr := s.persist(); werr != nil {
			return s, werr
		}
		return s, nil
	}
	if err != nil {
		return s, err
	}
	var f fileFormat
	if err := json.Unmarshal(raw, &f); err != nil {
		s.entries = Default()
		return s, fmt.Errorf("lexicon file is not valid JSON: %w", err)
	}
	s.entries = sanitize(f.Entries)
	return s, nil
}

// DefaultPath is the per-user location, beside the app's other settings.
func DefaultPath() string {
	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "T9EditorLIT", "lexicon.json")
}

// List returns a copy safe to hand to another goroutine.
func (s *Store) List() []postpass.Entry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]postpass.Entry, len(s.entries))
	for i, e := range s.entries {
		out[i] = postpass.Entry{Term: e.Term, Aliases: append([]string(nil), e.Aliases...)}
	}
	return out
}

// Replace validates and persists a new vocabulary. The write is atomic
// (temp file + rename) so a crash cannot leave half a JSON file behind.
func (s *Store) Replace(entries []postpass.Entry) error {
	clean := sanitize(entries)
	if len(clean) == 0 && len(entries) > 0 {
		return errors.New("no entry had a usable term")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	old := s.entries
	s.entries = clean
	if err := s.persistLocked(); err != nil {
		s.entries = old
		return err
	}
	return nil
}

func (s *Store) persist() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.persistLocked()
}

func (s *Store) persistLocked() error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return fmt.Errorf("create lexicon dir: %w", err)
	}
	raw, err := json.MarshalIndent(fileFormat{
		Version: 1,
		Entries: s.entries,
		Note:    "Creator vocabulary: Term is the canonical spelling, Aliases are how Whisper hears it.",
	}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// sanitize trims, dedupes and bounds the list.
func sanitize(entries []postpass.Entry) []postpass.Entry {
	out := make([]postpass.Entry, 0, len(entries))
	seenTerm := map[string]bool{}
	for _, e := range entries {
		term := strings.TrimSpace(e.Term)
		if term == "" || len([]rune(term)) > MaxTermRunes {
			continue
		}
		key := strings.ToLower(term)
		if seenTerm[key] {
			continue
		}
		seenTerm[key] = true
		aliases := make([]string, 0, len(e.Aliases))
		seenAlias := map[string]bool{}
		for _, a := range e.Aliases {
			a = strings.TrimSpace(a)
			if a == "" || strings.EqualFold(a, term) || len([]rune(a)) > MaxAliasRunes {
				continue
			}
			ak := strings.ToLower(a)
			if seenAlias[ak] {
				continue
			}
			seenAlias[ak] = true
			aliases = append(aliases, a)
			if len(aliases) >= MaxAliasesTerm {
				break
			}
		}
		out = append(out, postpass.Entry{Term: term, Aliases: aliases})
		if len(out) >= MaxEntries {
			break
		}
	}
	return out
}

// Default is the starter vocabulary for a Hinglish tech channel.
//
// It is deliberately small and obviously correct: a term the user does not
// use costs nothing (its aliases simply never match), while the measured
// failures in the playbook are fixed on the first run. The user can remove
// any entry.
func Default() []postpass.Entry {
	return []postpass.Entry{
		{Term: "RAG", Aliases: []string{"retrive argument document general", "रैग", "राग"}},
		{Term: "LLM", Aliases: []string{"एलएलएम", "एल एल एम", "एलेलम", "एलएम"}},
		{Term: "ChatGPT", Aliases: []string{"चैनल जीपीटी", "चैट जीपीटी", "चैटजीपीटी"}},
		{Term: "API", Aliases: []string{"ए पी आई", "एपीआई"}},
		{Term: "vector database", Aliases: []string{"वेक्टर डेटाबेस", "वेक्टर डाटाबेस"}},
		{Term: "context window", Aliases: []string{"कॉन्टेक्स्ट विंडो", "कांटेक्स्ट विंडो"}},
		{Term: "hybrid search", Aliases: []string{"हाइब्रिड सर्च"}},
	}
}
