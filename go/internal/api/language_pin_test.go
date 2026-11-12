package api

import "testing"

// The bootstrap rule: one chunk is an accident, two chunks in a row are a
// signal.
func TestThePinNeedsTwoAgreeingChunks(t *testing.T) {
	p := newLanguagePin("")

	if got := p.observe("hindi"); got != "" {
		t.Errorf("after one chunk the pin = %q, want no pin yet", got)
	}
	if got := p.observe("hindi"); got != "hi" {
		t.Errorf("after two agreeing chunks the pin = %q, want \"hi\"", got)
	}
	if got := p.observe("hindi"); got != "hi" {
		t.Errorf("the pin must stay put once it is set, got %q", got)
	}
}

// A display name must never reach the provider: Groq rejects it with a 400,
// and that is what turned one successful chunk into nine failed ones.
func TestThePinIsAlwaysAnISOCode(t *testing.T) {
	p := newLanguagePin("")

	p.observe("hindi")
	p.observe("hindi")
	if got := p.language(); got != "hi" {
		t.Errorf("language = %q, want the ISO code \"hi\"", got)
	}
}

// A chunk that reports a language nobody can map does not count as a
// disagreement and does not count as agreement either.
func TestAnUnknownLanguageIsIgnored(t *testing.T) {
	p := newLanguagePin("")

	p.observe("hindi")
	p.observe("klingon")
	if got := p.observe("hindi"); got != "hi" {
		t.Errorf("language = %q, want \"hi\": an unmappable name is not a disagreement", got)
	}
}

// The user's choice is never second-guessed. The detector is guessing; the
// user has ground truth.
func TestAUserChoiceIsForcedAndNeverReleased(t *testing.T) {
	p := newLanguagePin("en")

	if got := p.observe("hindi"); got != "en" {
		t.Errorf("language = %q, want the user's \"en\"", got)
	}
	if !p.isForced() {
		t.Error("a user choice must be marked as forced")
	}

	// Even a text that contradicts it does not change the pin - but it does
	// produce a warning, because "you pinned English and the transcript came
	// back in Devanagari" is exactly what the user needs to know.
	p.noteMismatch("आज हम बात करेंगे")
	if got := p.language(); got != "en" {
		t.Errorf("language = %q, want the user's \"en\" to survive", got)
	}
	if p.warningText() == "" {
		t.Error("a forced language that the text contradicts must warn")
	}
}

// A pin that the text contradicts is released, because a wrong pin costs
// every remaining chunk of the job.
//
// The contradiction that can be caught locally is the internal one: the model
// said "French" and then wrote Devanagari. That is the bootstrap bug the
// playbook calls out - a first chunk of music or noise, a detection of
// "fr", and the whole fifty-minute job decoded as French.
func TestAContradictedAutoPinIsReleased(t *testing.T) {
	p := newLanguagePin("")

	p.observe("french")
	p.observe("french")
	if p.language() != "fr" {
		t.Fatalf("setup: the pin should be \"fr\"")
	}

	p.noteMismatch("आज हम बात करेंगे")
	if got := p.language(); got != "" {
		t.Errorf("language = %q, want the pin released", got)
	}
	if p.warningText() == "" {
		t.Error("releasing a pin must explain itself")
	}
}

// The limit of the local check, stated plainly: a Hindi pin with Devanagari
// text is a *match*, so nothing is released.
//
// That means the accented-English case - Whisper detects "hindi" and writes
// Devanagari for a video that is really English - cannot be caught by
// counting scripts. The text and the detection agree with each other; only
// the user knows better. Which is why the forced language is never
// released, only warned about.
func TestAMatchingPinIsNotReleased(t *testing.T) {
	p := newLanguagePin("")

	p.observe("hindi")
	p.observe("hindi")
	p.noteMismatch("आज हम बात करेंगे")

	if got := p.language(); got != "hi" {
		t.Errorf("language = %q, want the pin to survive a matching text", got)
	}
	if p.warningText() != "" {
		t.Errorf("warning = %q, want none", p.warningText())
	}
}

// Hinglish in Roman script is not a conflict. The pin survives, because the
// app's own autocorrect pass writes Latin script on purpose.
func TestHinglishInRomanScriptDoesNotReleaseThePin(t *testing.T) {
	p := newLanguagePin("")

	p.observe("hindi")
	p.observe("hindi")
	p.noteMismatch("aaj hum RAG ke baare mein baat karenge")

	if got := p.language(); got != "hi" {
		t.Errorf("language = %q, want the pin to survive Roman-script Hinglish", got)
	}
	if p.warningText() != "" {
		t.Errorf("warning = %q, want none for normal code-switching", p.warningText())
	}
}

// A text in a different writing system entirely is a real conflict.
func TestATextInAnotherScriptReleasesThePin(t *testing.T) {
	p := newLanguagePin("")

	p.observe("tamil")
	p.observe("tamil")
	p.noteMismatch("आज हम बात करेंगे")

	if got := p.language(); got != "" {
		t.Errorf("language = %q, want the pin released", got)
	}
}

// A release resets the streak: the pin has to earn its place again.
func TestAReleasedPinHasToAgreeAgain(t *testing.T) {
	p := newLanguagePin("")

	p.observe("french")
	p.observe("french")
	p.noteMismatch("आज हम बात करेंगे")

	if got := p.observe("hindi"); got != "" {
		t.Errorf("language = %q, want one chunk to be too few after a release", got)
	}
	if got := p.observe("hindi"); got != "hi" {
		t.Errorf("language = %q, want the pin to be re-established", got)
	}
}

// A user choice given as a display name is normalised, not forwarded raw.
func TestAUserChoiceIsNormalisedToo(t *testing.T) {
	p := newLanguagePin("Hindi")

	if got := p.language(); got != "hi" {
		t.Errorf("language = %q, want \"hi\"", got)
	}
}
