package script

import "testing"

// The live evidence from the playbook: a Hinglish AI tutorial where Whisper
// wrote 350 of 354 segments in Devanagari even though the speaker was
// mixing Hindi and English — including the English tech terms, which came
// back as "चैनल जीपीटी" and "फ्लेक्सिप एडिया".
const hinglish = "आज हम समझेंगे कि RAG कैसे काम करता है"

func TestDevanagariIsCountedAsDevanagari(t *testing.T) {
	r := Analyze(hinglish)

	if r.Total() == 0 {
		t.Fatal("no letters counted")
	}
	if got := r.Share(ScriptDevanagari); got < 0.6 {
		t.Errorf("Devanagari share = %.2f, want most of the line", got)
	}
	if got := r.Share(ScriptLatin); got < 0.1 {
		t.Errorf("Latin share = %.2f, want the English words to show up too", got)
	}
	if r.Dominant() != ScriptDevanagari {
		t.Errorf("dominant script = %q, want devanagari", r.Dominant())
	}
}

// Digits, punctuation and emoji carry no script. Counting them would drown
// a line that is mostly a number.
func TestOnlyLettersAreCounted(t *testing.T) {
	r := Analyze("12345 !!! 🎉???")

	if r.Total() != 0 {
		t.Errorf("counted %d letters from a text with none", r.Total())
	}
	if r.Dominant() != ScriptUnknown {
		t.Errorf("dominant script = %q, want unknown", r.Dominant())
	}
}

// Case 13: an accented English speaker that Whisper detected as Hindi. The
// text came back in Devanagari while the language is pinned to English — a
// wrong pin the user has to be able to see.
func TestPinnedEnglishWithDevanagariTextIsAMismatch(t *testing.T) {
	v := Check("आज हम बात करेंगे के बारे में", "en")

	if v.Matches {
		t.Errorf("a Devanagari transcript pinned to English must be a mismatch: %+v", v)
	}
	if v.Reason == "" {
		t.Error("a mismatch must come with a reason the UI can show")
	}
	if v.Expected != ScriptLatin {
		t.Errorf("expected script = %q, want latin", v.Expected)
	}
}

// Case 12: Hinglish is code-switching, and code-switching is normal. A
// Hindi line with English words in it is not a mismatch — the whole app is
// built for that recording.
func TestHinglishCodeSwitchingIsNotAMismatch(t *testing.T) {
	v := Check(hinglish, "hi")

	if !v.Matches {
		t.Errorf("Hinglish pinned to Hindi must match: %+v", v)
	}
}

// The other direction: a language with its own script that is written in
// another script is a wrong pin.
func TestPinnedTamilWithDevanagariTextIsAMismatch(t *testing.T) {
	v := Check("आज का ट्यूटोरियल बहुत अच्छा है", "ta")

	if v.Matches {
		t.Errorf("a Devanagari transcript pinned to Tamil must be a mismatch: %+v", v)
	}
	if v.Expected != ScriptTamil {
		t.Errorf("expected script = %q, want tamil", v.Expected)
	}
}

// An English line with a couple of Hindi words in it stays a match: the
// threshold for "the other script dominates" is high on purpose.
func TestMostlyLatinTextWithSomeDevanagariStillMatches(t *testing.T) {
	text := "This is the retrieval augmented generation pipeline and it works, हमने आज इसको समझा"

	v := Check(text, "en")

	if !v.Matches {
		t.Errorf("a mostly English line with two Hindi words must match: %+v", v)
	}
}

// Nothing to check is never a problem. A line with no letters must not raise
// a mismatch warning.
func TestEmptyTextMatchesEverything(t *testing.T) {
	for _, code := range []string{"en", "hi", "ta", "fr"} {
		v := Check("123 ... !!!", code)
		if !v.Matches {
			t.Errorf("text without letters must match %q", code)
		}
	}
}

// An unknown code has no expected script, so there is nothing to check
// against.
func TestUnknownLanguageHasNoExpectedScript(t *testing.T) {
	if got := ExpectedScript("xx"); got != ScriptLatin {
		t.Errorf("expected script for an unknown code = %q, want latin", got)
	}
	if got := ExpectedScript("hi-IN"); got != ScriptDevanagari {
		t.Errorf("expected script for hi-IN = %q, want devanagari", got)
	}
}

// Case 11: only lines that are actually in a non-Latin script are worth
// sending to a Romanisation pass.
func TestOnlyNonLatinLinesAreRomanisable(t *testing.T) {
	if !Romanisable(hinglish) {
		t.Error("a Devanagari line must be romanisable")
	}
	if Romanisable("this line is already in Roman script") {
		t.Error("a Latin line must not be sent for romanisation")
	}
	if Romanisable("") {
		t.Error("an empty line must not be sent for romanisation")
	}
}

// The script list is shown on the line ("Devanagari + Latin"), so it has to
// be ordered by how much of the line each script covers.
func TestScriptsAreListedMostCommonFirst(t *testing.T) {
	r := Analyze(hinglish)
	scripts := r.Scripts()

	if len(scripts) < 2 {
		t.Fatalf("expected two scripts, got %v", scripts)
	}
	if scripts[0] != ScriptDevanagari {
		t.Errorf("first script = %q, want devanagari", scripts[0])
	}
}
