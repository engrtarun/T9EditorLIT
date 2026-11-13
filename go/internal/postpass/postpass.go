// Package postpass cleans a raw transcript without asking a model to decide
// anything about the user's content.
//
// These are the cheap, deterministic passes the playbook asks for in Group D
// and E: bracket tags become icons instead of noise (case 23), a hallucinated
// loop collapses to one line (case 24), overlapping words are marked as
// crosstalk and never auto-cut (case 22), retakes become a confirmation
// instead of a deletion (case 26), and the creator's vocabulary fixes the
// spellings Whisper keeps getting wrong (case 39).
//
// The rule throughout: measure and mark, do not rewrite. The only text this
// package edits is a lexicon replacement, and that keeps the raw line in
// OriginalText so nothing is lost.
package postpass

import (
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// Result reports what a pass changed, for the daemon log and the job UI.
type Result struct {
	Tags      int `json:"tags"`
	Loops     int `json:"loops"`
	Retakes   int `json:"retakes"`
	Crosstalk int `json:"crosstalk"`
	Lexicon   int `json:"lexicon"`
}

// Entry is one creator-vocabulary term and the spellings Whisper uses for it.
//
// Aliases are matched case-insensitively and replaced with Term. The term is
// stored separately so the canonical spelling is always explicit: "RAG" is a
// term, "retrive argument document general" is an alias.
type Entry struct {
	Term    string   `json:"term"`
	Aliases []string `json:"aliases"`
}

// Process runs every pass, in the order the results depend on:
//
//  1. tags first, because they do not touch text and the UI wants them even
//     when every other pass abstains
//  2. crosstalk before loops, so a loop inside an overlap is still reported
//     as an overlap (the safer of the two)
//  3. retakes before loops, because a two-line retake is a suggestion and a
//     three-line loop is a collapse
//  4. lexicon last: it is the only pass that changes text
func Process(segments []model.Segment, entries []Entry) Result {
	var res Result
	res.Tags = ApplyBrackets(segments)
	res.Crosstalk = MarkCrosstalk(segments)
	res.Retakes = FlagRetakes(segments)
	res.Loops = CollapseLoops(segments)
	res.Lexicon = ApplyLexicon(segments, entries)
	return res
}

// ---------------------------------------------------------------- brackets

// bracketRe finds the three shapes Whisper uses for non-speech labels:
// [Music], (applause) and a bare ♪. It deliberately does not accept arbitrary
// parentheses: "(2024)" and "(optional)" are content, not sound effects.
var bracketRe = regexp.MustCompile(`\[([^\[\]]{1,60})\]|\(([^()]{1,60})\)|(?:^|\s)(♪{1,5})(?:\s|$)`)

// knownTags maps every spelling this app understands to one icon name.
//
// The list is closed on purpose: an unknown bracket is left alone, because
// "(see chapter 3)" is a real parenthetical and turning it into an applause
// icon would be worse than leaving it as text.
var knownTags = map[string]string{
	"music": "music", "musique": "music", "♪": "music", "♫": "music",
	"applause": "applause", "clapping": "applause", "claps": "applause",
	"laughter": "laughter", "laughs": "laughter", "laughing": "laughter",
	"silence": "silence", "quiet": "silence",
	"door slams": "noise", "noise": "noise", "static": "noise",
	"inaudible": "inaudible", "unintelligible": "inaudible",
	"cough": "cough", "coughs": "cough", "sigh": "sigh", "sighs": "sigh",
	"beep": "beep", "bleep": "beep",
	"cheering": "cheering", "crowd": "cheering",
	"intro": "music", "outro": "music",
}

// ApplyBrackets records the non-speech tags on each segment and returns how
// many lines carried one. Text is never modified: the tag is data, and the UI
// decides whether to render an icon or show the words.
func ApplyBrackets(segments []model.Segment) int {
	seen := 0
	for i := range segments {
		tags := Tags(segments[i].Text)
		if len(tags) == 0 {
			continue
		}
		segments[i].Tags = tags
		seen++
	}
	return seen
}

// Tags returns the known non-speech tags in a line, deduplicated, in order.
func Tags(text string) []string {
	matches := bracketRe.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return nil
	}
	out := make([]string, 0, len(matches))
	seen := map[string]bool{}
	for _, m := range matches {
		raw := m[1]
		if raw == "" {
			raw = m[2]
		}
		if raw == "" {
			raw = m[3]
		}
		key := strings.ToLower(strings.TrimSpace(raw))
		tag, ok := knownTags[key]
		if !ok {
			// Devanagari/Hinglish sound labels are not in the map, but they are
			// still bracketed non-speech markers; keep the normalised text as
			// the tag so the UI can show it verbatim.
			if !strings.Contains(key, "♪") && !strings.Contains(key, "♫") && !looksLikeSoundCue(key) {
				continue
			}
			tag = key
		}
		if tag != "" && !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}

// looksLikeSoundCue covers the local-language labels a Hindi transcript uses:
// [संगीत], [तालियाँ], [हँसी].
func looksLikeSoundCue(s string) bool {
	for _, word := range []string{"संगीत", "ताली", "हँसी", "हसी", "शोर", "मौन", "आवाज़", "आवाज"} {
		if strings.Contains(s, word) {
			return true
		}
	}
	return false
}

// VisibleText replaces known bracket tags with their icon, for a cut-list
// preview. The transcript itself keeps the original string.
func VisibleText(text string, tags []string) string {
	if len(tags) == 0 {
		return text
	}
	out := bracketRe.ReplaceAllStringFunc(text, func(m string) string {
		inner := strings.TrimSpace(strings.Trim(m, "[]()"))
		if inner == "" {
			return m
		}
		key := strings.ToLower(inner)
		if tag, ok := knownTags[key]; ok {
			return tagIcon(tag)
		}
		if looksLikeSoundCue(key) {
			return tagIcon("noise")
		}
		return m
	})
	return strings.Join(strings.Fields(out), " ")
}

func tagIcon(tag string) string {
	switch tag {
	case "music":
		return "♪"
	case "applause":
		return "👏"
	case "laughter":
		return "😄"
	case "silence":
		return "·"
	case "inaudible":
		return "?"
	case "cough":
		return "🤧"
	case "sigh":
		return "…"
	case "beep":
		return "▮"
	case "cheering":
		return "📣"
	default:
		return "🔊"
	}
}

// ------------------------------------------------------------------- loops

// Stock phrases Whisper emits over silence. A run of these is never content.
var stockPhrases = map[string]bool{
	"thankyouforwatching": true,
	"thanksforwatching":   true,
	"pleasesubscribe":     true,
	"likeandsubscribe":    true,
	"seeyounexttime":      true,
}

// CollapseLoops finds three or more consecutive identical lines and keeps the
// first one as the representative (case 24).
//
// Duplicates are marked cut, because a verbatim run that long over a gap is a
// hallucination by construction: a human can repeat a sentence twice, not
// thirty times with silence between. The first line stays, so the text is
// still visible; the run is reported on it as RepeatCount.
func CollapseLoops(segments []model.Segment) int {
	if len(segments) < 2 {
		return 0
	}
	marked := 0
	for i := 0; i < len(segments); {
		key := normalize(segments[i].Text)
		if len([]rune(key)) < 3 {
			i++
			continue
		}
		j := i + 1
		for j < len(segments) {
			if normalize(segments[j].Text) != key {
				break
			}
			gap := segments[j].StartSecs - segments[j-1].EndSecs
			if gap > 45 {
				break
			}
			j++
		}
		n := j - i
		runSecs := segments[j-1].EndSecs - segments[i].StartSecs
		// Three is the floor for a normal line; a stock phrase twice is
		// already a hallucination (Whisper says "Thank you." on music).
		if n < 2 || (n < 3 && !stockPhrases[key]) {
			i = j
			continue
		}
		// A three-line run that spans less than 2 s is a real stammer, not a
		// hallucination; let the retake pass handle it.
		if runSecs < 2 {
			i = j
			continue
		}
		segments[i].RepeatCount = n
		segments[i].RepeatKind = "loop"
		segments[i].Reason = appendReason(segments[i].Reason,
			"Whisper repeated this line over non-speech audio")
		for k := i + 1; k < j; k++ {
			segments[k].Repeated = true
			segments[k].RepeatOf = segments[i].ID
			segments[k].RepeatKind = "loop"
			segments[k].Keep = false
			segments[k].Flag = model.FlagSilence
			segments[k].Reason = appendReason(segments[k].Reason,
				"Repeat of the first line - collapsed")
			marked++
		}
		i = j
	}
	return marked
}

// ------------------------------------------------------------------ retakes

// FlagRetakes finds a line that restarts in the next line (case 26).
//
// This is deliberately a *suggestion*, never a cut: "I mean... I mean the
// third option" and "I mean the third option" look identical to a string
// comparison, and only the speaker knows which one was the emphasis. The pass
// therefore sets NeedsConfirm and leaves Keep alone.
func FlagRetakes(segments []model.Segment) int {
	n := 0
	for i := 0; i+1 < len(segments); i++ {
		a, b := &segments[i], &segments[i+1]
		if a.Repeated || b.Repeated || a.Crosstalk || b.Crosstalk {
			continue
		}
		if b.StartSecs-a.EndSecs > 2.5 {
			continue
		}
		ta, tb := tokens(a.Text), tokens(b.Text)
		if len(ta) < 2 || len(tb) < 2 {
			continue
		}
		common := commonPrefix(ta, tb)
		if common < 2 {
			continue
		}
		shorter := len(ta)
		if len(tb) < shorter {
			shorter = len(tb)
		}
		if common < shorter*3/4 {
			continue
		}
		switch {
		case len(tb) > len(ta):
			markFumble(a, b, "Retake: this line starts again in the next line", "Completed version of the previous line")
		case len(ta) > len(tb):
			markFumble(b, a, "Retake: this line starts again in the previous line", "Completed version of the next line")
		default:
			// Same words twice: emphasis, not a fumble. Still worth a chip.
			a.NeedsConfirm = true
			a.RepeatKind = "restatement"
			a.Reason = appendReason(a.Reason, "Said twice in a row - emphasis or a repeated take")
			b.NeedsConfirm = true
			b.RepeatKind = "restatement"
			b.Reason = appendReason(b.Reason, "Second reading of the previous line")
		}
		n++
	}
	// Inside one line: "I mean I mean the third option".
	for i := range segments {
		if segments[i].RepeatKind == "" && hasImmediateStutter(segments[i].Text) {
			segments[i].NeedsConfirm = true
			segments[i].RepeatKind = "stutter"
			segments[i].Reason = appendReason(segments[i].Reason,
				"A phrase repeats inside this line - confirm before cutting")
			n++
		}
	}
	return n
}

func markFumble(fumble, complete *model.Segment, fumbleReason, completeReason string) {
	fumble.RepeatKind = "fumble"
	fumble.RepeatOf = complete.ID
	fumble.NeedsConfirm = true
	fumble.Keep = true
	fumble.Flag = model.FlagFumble
	fumble.Reason = appendReason(fumble.Reason, fumbleReason)

	complete.NeedsConfirm = true
	complete.RepeatKind = "restatement"
	complete.Keep = true
	if complete.Flag == model.FlagNone || complete.Flag == "" {
		complete.Flag = model.FlagRetake
	}
	complete.Reason = appendReason(complete.Reason, completeReason)
}

// hasImmediateStutter finds a repeated 1-3 token run at the start of the line.
// It is conservative: "very very good" is emphasis, so a single repeated word
// only counts when the line also restarts after it. Two- and three-word
// repeats are the shape of a false start ("I mean I mean", "the third the
// third option").
func hasImmediateStutter(text string) bool {
	t := tokens(text)
	for size := 2; size <= 3; size++ {
		if len(t) < size*2 {
			continue
		}
		if equalTokens(t[:size], t[size:size*2]) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- crosstalk

// MarkCrosstalk finds two lines whose words overlap in time (case 22).
//
// Whisper emits one segment per speaker turn, so an overlap here means the
// turns themselves collided. Marking both is the safe direction: the auto-cut
// pass skips crosstalk lines, and the user decides which voice to keep.
func MarkCrosstalk(segments []model.Segment) int {
	if len(segments) < 2 {
		return 0
	}
	marked := 0
	// Segments arrive ordered by start time, but a merge from several chunks
	// can leave a neighbour slightly out of order; sort a copy of the indices
	// rather than trusting the slice.
	order := make([]int, len(segments))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool {
		return segments[order[a]].StartSecs < segments[order[b]].StartSecs
	})

	for oi := 0; oi < len(order); oi++ {
		i := order[oi]
		for oj := oi + 1; oj < len(order); oj++ {
			j := order[oj]
			if segments[j].StartSecs > segments[i].EndSecs+2 {
				break
			}
			overlap := overlapSecs(segments[i], segments[j])
			need := 0.5
			if len(segments[i].Words) > 0 && len(segments[j].Words) > 0 {
				need = 0.3
			}
			if overlap < need {
				continue
			}
			// A loop duplicate is not a second voice.
			if segments[j].Repeated || segments[i].Repeated {
				continue
			}
			changed := false
			for _, k := range []int{i, j} {
				if !segments[k].Crosstalk {
					segments[k].Crosstalk = true
					segments[k].NeedsConfirm = true
					segments[k].Keep = true
					segments[k].Reason = appendReason(segments[k].Reason,
						"Two voices overlap here (crosstalk) - auto-cut will not touch it")
					changed = true
				}
			}
			if changed {
				marked++
			}
		}
	}
	return marked
}

func overlapSecs(a, b model.Segment) float64 {
	start := a.StartSecs
	if b.StartSecs > start {
		start = b.StartSecs
	}
	end := a.EndSecs
	if b.EndSecs < end {
		end = b.EndSecs
	}
	if end <= start {
		return 0
	}
	return end - start
}

// ------------------------------------------------------------------ lexicon

// ApplyLexicon replaces known phonetic spellings with the creator's canonical
// term (case 39). It returns how many lines changed.
//
// Aliases are applied longest-first so "retrive argument document general"
// wins over a shorter alias that happens to be a prefix. The raw line goes to
// OriginalText exactly once, so a second pass cannot overwrite the truth.
func ApplyLexicon(segments []model.Segment, entries []Entry) int {
	type alias struct {
		from string
		term string
	}
	aliases := make([]alias, 0, len(entries)*2)
	for _, e := range entries {
		term := strings.TrimSpace(e.Term)
		if term == "" {
			continue
		}
		for _, a := range e.Aliases {
			a = strings.TrimSpace(a)
			if len([]rune(a)) < 2 || strings.EqualFold(a, term) {
				continue
			}
			aliases = append(aliases, alias{from: a, term: term})
		}
	}
	if len(aliases) == 0 {
		return 0
	}
	sort.SliceStable(aliases, func(i, j int) bool {
		return len([]rune(aliases[i].from)) > len([]rune(aliases[j].from))
	})

	changed := 0
	for i := range segments {
		text := segments[i].Text
		hits := make([]string, 0, 2)
		for _, a := range aliases {
			next, ok := replaceInsensitive(text, a.from, a.term)
			if !ok {
				continue
			}
			text = next
			hits = append(hits, a.term)
		}
		if len(hits) == 0 {
			continue
		}
		if segments[i].OriginalText == "" {
			segments[i].OriginalText = segments[i].Text
		}
		segments[i].Text = text
		segments[i].LexiconHits = append(segments[i].LexiconHits, hits...)
		changed++
	}
	return changed
}

// replaceInsensitive replaces every occurrence of from with term, matching
// case-insensitively. Latin aliases get a word-boundary check so "api" does
// not rewrite "rapid"; scripts without case (Devanagari) use a plain match.
func replaceInsensitive(text, from, term string) (string, bool) {
	if from == "" {
		return text, false
	}
	ascii := isASCII(from)
	var b strings.Builder
	b.Grow(len(text))
	changed := false
	lower := strings.ToLower(text)
	needle := strings.ToLower(from)
	start := 0
	for {
		i := strings.Index(lower[start:], needle)
		if i < 0 {
			break
		}
		i += start
		end := i + len(from)
		if ascii && !wordish(text, i, end) {
			b.WriteString(text[start:end])
			start = end
			continue
		}
		b.WriteString(text[start:i])
		b.WriteString(term)
		start = end
		changed = true
	}
	if !changed {
		return text, false
	}
	b.WriteString(text[start:])
	return b.String(), true
}

func isASCII(s string) bool {
	for _, r := range s {
		if r > unicode.MaxASCII {
			return false
		}
	}
	return true
}

func wordish(s string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(s[:start])
		if isWordRune(r) {
			return false
		}
	}
	if end < len(s) {
		r, _ := utf8.DecodeRuneInString(s[end:])
		if isWordRune(r) {
			return false
		}
	}
	return true
}

func isWordRune(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

// ------------------------------------------------------------------ helpers

func normalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func tokens(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
}

func commonPrefix(a, b []string) int {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	i := 0
	for i < n && a[i] == b[i] {
		i++
	}
	return i
}

func equalTokens(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func appendReason(old, add string) string {
	if old == "" {
		return add
	}
	if strings.Contains(old, add) {
		return old
	}
	return old + " · " + add
}
