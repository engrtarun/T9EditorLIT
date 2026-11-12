// Package script counts which Unicode script a transcript line is written in.
//
// It exists because "what language is this?" and "what script is this
// written in?" are different questions, and the second one is the one a
// local machine can answer for free and instantly.
//
// Whisper auto-detects the language per request. On a Hinglish recording it
// may answer "hindi" for one chunk and "english" for the next, and on an
// accented English speaker it may answer "hindi" and then write the whole
// line in Devanagari. Both are visible from the text alone: the script the
// model chose is printed on the page.
//
// Counting script blocks costs nothing - no network, no model, no RAM beyond
// the line itself - so it is used twice: as a cross-check on a detected
// language (Cases 12, 13 and the bootstrap problem in the playbook's B4), and
// as the input to a Romanisation request (Case 11).
package script

import (
	"sort"
	"strings"
	"unicode"
)

// Script is a Unicode script family, named the way the font stacks and the
// language pickers name them.
type Script string

const (
	ScriptUnknown    Script = ""
	ScriptLatin      Script = "latin"
	ScriptDevanagari Script = "devanagari"
	ScriptBengali    Script = "bengali"
	ScriptGurmukhi   Script = "gurmukhi"
	ScriptGujarati   Script = "gujarati"
	ScriptOriya      Script = "oriya"
	ScriptTamil      Script = "tamil"
	ScriptTelugu     Script = "telugu"
	ScriptKannada    Script = "kannada"
	ScriptMalayalam  Script = "malayalam"
	ScriptSinhala    Script = "sinhala"
	ScriptThai       Script = "thai"
	ScriptArabic     Script = "arabic"
	ScriptHebrew     Script = "hebrew"
	ScriptCyrillic   Script = "cyrillic"
	ScriptGreek      Script = "greek"
	ScriptCJK        Script = "cjk"
	ScriptHangul     Script = "hangul"
)

// block is one Unicode range and the script it belongs to.
type block struct {
	lo, hi rune
	script Script
}

// blocks is the table the classifier walks.
//
// The ranges are the Unicode blocks for the scripts an Indian-language
// tutorial actually contains, plus the three big world scripts (Arabic,
// Cyrillic, CJK). A character outside every block is Latin if it is a
// letter, because the overwhelming majority of unlisted letters in a
// transcript are ASCII.
var blocks = []block{
	{0x0900, 0x097F, ScriptDevanagari}, // Devanagari
	{0x0980, 0x09FF, ScriptBengali},    // Bengali
	{0x0A00, 0x0A7F, ScriptGurmukhi},   // Gurmukhi
	{0x0A80, 0x0AFF, ScriptGujarati},   // Gujarati
	{0x0B00, 0x0B7F, ScriptOriya},      // Oriya
	{0x0B80, 0x0BFF, ScriptTamil},      // Tamil
	{0x0C00, 0x0C7F, ScriptTelugu},     // Telugu
	{0x0C80, 0x0CFF, ScriptKannada},    // Kannada
	{0x0D00, 0x0D7F, ScriptMalayalam},  // Malayalam
	{0x0D80, 0x0DFF, ScriptSinhala},    // Sinhala
	{0x0E00, 0x0E7F, ScriptThai},       // Thai
	{0x0590, 0x05FF, ScriptHebrew},     // Hebrew
	{0x0600, 0x06FF, ScriptArabic},     // Arabic
	{0x0750, 0x077F, ScriptArabic},     // Arabic Supplement
	{0x08A0, 0x08FF, ScriptArabic},     // Arabic Extended-A
	{0xFB50, 0xFDFF, ScriptArabic},     // Arabic Presentation A
	{0xFE70, 0xFEFF, ScriptArabic},     // Arabic Presentation B
	{0x0370, 0x03FF, ScriptGreek},      // Greek
	{0x0400, 0x04FF, ScriptCyrillic},   // Cyrillic
	{0x3040, 0x30FF, ScriptCJK},        // Hiragana + Katakana
	{0x3400, 0x4DBF, ScriptCJK},        // CJK Extension A
	{0x4E00, 0x9FFF, ScriptCJK},        // CJK Unified Ideographs
	{0xAC00, 0xD7AF, ScriptHangul},     // Hangul syllables
	{0x1100, 0x11FF, ScriptHangul},     // Hangul Jamo
}

// Ratio is how many letters of a text fall into each script.
//
// Only letters are counted. Digits, punctuation, spaces and emoji are
// skipped: they carry no script and would drown the signal on a line that
// is mostly a number.
type Ratio struct {
	counts map[Script]int
	total  int
}

// Analyze counts the scripts of the letters in text.
//
// An empty text, or one with no letters at all, gives a zero ratio: there is
// nothing to say about it, and every check that uses this has to treat that
// as "no opinion" rather than as a mismatch.
func Analyze(text string) Ratio {
	r := Ratio{counts: map[Script]int{}}
	for _, ch := range text {
		if !unicode.IsLetter(ch) {
			continue
		}
		s := scriptOf(ch)
		r.counts[s]++
		r.total++
	}
	return r
}

// scriptOf classifies one letter.
func scriptOf(ch rune) Script {
	for _, b := range blocks {
		if ch >= b.lo && ch <= b.hi {
			return b.script
		}
	}
	// Anything left that is a letter is Latin: ASCII, Latin-1, Latin
	// Extended, and the maths/greek-looking letters that slip through.
	return ScriptLatin
}

// Total is how many letters were counted.
func (r Ratio) Total() int { return r.total }

// Share is the fraction of letters written in one script, 0..1.
func (r Ratio) Share(s Script) float64 {
	if r.total == 0 {
		return 0
	}
	return float64(r.counts[s]) / float64(r.total)
}

// Dominant is the script most of the text is written in.
//
// Ties break towards the script that sorts first, so the answer is stable:
// the same text always gives the same script.
func (r Ratio) Dominant() Script {
	if r.total == 0 {
		return ScriptUnknown
	}
	best := ScriptUnknown
	bestCount := 0
	for s, c := range r.counts {
		if c > bestCount || (c == bestCount && s < best) {
			best, bestCount = s, c
		}
	}
	return best
}

// Scripts lists the scripts present in the text, most common first.
//
// Used by the UI to show "Devanagari + Latin" on a Hinglish line.
func (r Ratio) Scripts() []Script {
	out := make([]Script, 0, len(r.counts))
	for s := range r.counts {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if r.counts[out[i]] != r.counts[out[j]] {
			return r.counts[out[i]] > r.counts[out[j]]
		}
		return out[i] < out[j]
	})
	return out
}

// languageScripts maps an ISO-639-1 code to the script its writing system
// uses.
//
// It is the table that makes "the model wrote Hindi in Latin script" and
// "the model wrote English in Devanagari" two different, visible mistakes.
var languageScripts = map[string]Script{
	"hi": ScriptDevanagari, "mr": ScriptDevanagari, "ne": ScriptDevanagari,
	"bn": ScriptBengali, "pa": ScriptGurmukhi, "gu": ScriptGujarati,
	"or": ScriptOriya, "ta": ScriptTamil, "te": ScriptTelugu,
	"kn": ScriptKannada, "ml": ScriptMalayalam, "si": ScriptSinhala,
	"th": ScriptThai, "ar": ScriptArabic, "fa": ScriptArabic,
	"ur": ScriptArabic, "ps": ScriptArabic, "sd": ScriptArabic,
	"he": ScriptHebrew, "el": ScriptGreek, "ru": ScriptCyrillic,
	"bg": ScriptCyrillic, "uk": ScriptCyrillic, "sr": ScriptCyrillic,
	"mk": ScriptCyrillic, "be": ScriptCyrillic, "zh": ScriptCJK,
	"ja": ScriptCJK, "ko": ScriptHangul,
}

// ExpectedScript is the script a language is normally written in.
//
// An empty result means "this language has no single script here" - English,
// German, French and the rest of the Latin-script languages. That is not the
// same as "Latin": a user who pins `en` on a Hinglish recording is not
// making a mistake, they are asking for the Roman script.
func ExpectedScript(langCode string) Script {
	code := strings.ToLower(strings.TrimSpace(langCode))
	if i := strings.IndexAny(code, "-_"); i > 0 {
		code = code[:i]
	}
	if s, ok := languageScripts[code]; ok {
		return s
	}
	return ScriptLatin
}

// mismatchShare is how much of a text has to be in the wrong script before it
// counts as a mismatch rather than as code-switching.
//
// Hinglish is the reason this number exists: a Hindi sentence with two
// English words in it is normal, and a line that is 30% Latin inside a
// Devanagari transcript is not a bug. But a transcript that is 90% Devanagari
// when the language is pinned to English is a wrong pin, and the user needs
// to be told.
const mismatchShare = 0.6

// minExpectedShare is how much of a non-Latin-script language's text has to
// be in that script before the line counts as a match.
//
// A Bhojpuri line written in Devanagari is a match for `hi` even when a fifth
// of it is English loanwords.
const minExpectedShare = 0.25

// Verdict is the result of checking a text against a pinned language.
type Verdict struct {
	// Expected is the script the pinned language should be written in.
	Expected Script
	// Observed is the script the text is mostly written in.
	Observed Script
	// Share is how much of the text is in the observed script.
	Share float64
	// Matches is false when the text and the pinned language disagree.
	Matches bool
	// Reason explains a mismatch in one sentence, for the UI.
	Reason string
}

// Check compares a text against a pinned language.
//
// The rules are deliberately asymmetric, because the two mistakes are not
// symmetric:
//
//   - A language with its own script (Hindi, Tamil, Arabic) must actually be
//     written in that script. Writing "hi" in Devanagari when the pin says
//     "ta" is a wrong pin, full stop.
//   - A Latin-script language (English, German, French) may contain another
//     script without being wrong: that is code-switching, which is the norm
//     in this app's own use case. It only becomes a mismatch when the
//     *other* script dominates - which is what an accented-English speaker
//     detected as "hindi" looks like.
//
// An empty text, or a text with no letters, matches: there is nothing to
// check, and a check that invents a problem is worse than no check.
func Check(text, langCode string) Verdict {
	ratio := Analyze(text)
	expected := ExpectedScript(langCode)

	v := Verdict{Expected: expected, Observed: ratio.Dominant(), Matches: true}
	if ratio.Total() == 0 {
		return v
	}
	v.Share = ratio.Share(v.Observed)

	if expected == ScriptLatin {
		// Latin-script language: only a dominant *other* script is a
		// mismatch.
		if v.Observed != ScriptLatin && v.Share >= mismatchShare {
			v.Matches = false
			v.Reason = "text is mostly " + string(v.Observed) +
				" but the language is pinned to a Latin-script language"
		}
		return v
	}

	if ratio.Share(expected) < minExpectedShare {
		v.Matches = false
		v.Reason = "text is mostly " + string(v.Observed) +
			", not the " + string(expected) + " that " + langCode + " is written in"
	}
	return v
}

// Conflicts reports whether the text is written in a script that
// *contradicts* the pinned language, as opposed to merely code-switching
// out of it.
//
// This is the stricter, decision-grade question, and it is the one that may
// release an auto-detected pin:
//
//   - Pinned English, text in Devanagari: a conflict. The pin is wrong (the
//     accented-English speaker the edge cases describe), or the user meant a
//     different language.
//   - Pinned Hindi, text in Latin: NOT a conflict. That is Hinglish written
//     in Roman script, which is normal - and it is what this app's own
//     autocorrect pass produces on purpose.
//   - Pinned Hindi, text in Tamil: a conflict. The text is in a different
//     writing system entirely.
//
// Latin is the neutral script here: code-switching into it is the norm in
// this app's use case, so it never contradicts a pin.
func Conflicts(text, langCode string) bool {
	ratio := Analyze(text)
	if ratio.Total() == 0 {
		return false
	}
	observed := ratio.Dominant()
	expected := ExpectedScript(langCode)
	if observed == ScriptLatin {
		return false
	}
	return observed != expected
}

// Romanisable reports whether the text contains a script that a Romanisation
// pass would actually change.
//
// Case 11 asks for Hinglish in Roman script when the user wants it. Sending
// a line that is already Latin to the model costs a token and can only make
// it worse, so the caller checks first.
func Romanisable(text string) bool {
	r := Analyze(text)
	if r.Total() == 0 {
		return false
	}
	return r.Share(ScriptDevanagari) > 0 || r.Share(ScriptArabic) > 0 ||
		r.Share(ScriptTamil) > 0 || r.Share(ScriptTelugu) > 0 ||
		r.Share(ScriptBengali) > 0 || r.Share(ScriptKannada) > 0 ||
		r.Share(ScriptGujarati) > 0 || r.Share(ScriptGurmukhi) > 0 ||
		r.Share(ScriptOriya) > 0 || r.Share(ScriptMalayalam) > 0 ||
		r.Share(ScriptSinhala) > 0 || r.Share(ScriptThai) > 0
}
