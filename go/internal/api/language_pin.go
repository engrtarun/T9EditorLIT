package api

// Which language is this job in, and how sure are we?
//
// The edge-case playbook is blunt about the old behaviour: "the first
// successful chunk's language pin ho jaati hai, phir poori job usi par
// chalti hai". One chunk decides the language of a fifty-minute recording,
// and the chunk it decides on may be a title card, a music intro or a clip
// of somebody speaking in another language.
//
// The rules here replace that with something that can be wrong without
// ruining the job:
//
//   - A language the *user* picked is never second-guessed. The user has
//     ground truth; the detector does not.
//   - An auto-detected language is pinned only after two chunks in a row
//     agree on it. One chunk is an accident; two is a signal.
//   - Whatever the model wrote is checked against the script it was written
//     in. "Pinned Hindi, but the text came back in Devanagari" and "pinned
//     Hindi, but the text came back in Latin" are different problems, and
//     only the second one means the pin is wrong.

import (
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/cloud"
	"github.com/engrtarun/T9EditorLIT/go/internal/script"
)

// agreementChunks is how many consecutive chunks have to report the same
// language before the job pins it.
//
// Two is the smallest number that is not a coincidence. It costs one extra
// chunk of detection - and detection is free, because the pin is only
// *used* on later chunks.
const agreementChunks = 2

// languagePin is the state of one job's language decision.
type languagePin struct {
	// forced is the language the user asked for. When it is set, every other
	// rule is out of order: the user is right and the detector is guessing.
	forced string
	// current is the language in force for the next request.
	current string
	// candidate is the language the last chunk reported.
	candidate string
	// agreements counts how many chunks in a row reported the candidate.
	agreements int
	// warning explains a disagreement, for the UI.
	warning string
}

// newLanguagePin starts a pin for a job.
//
// A language the caller supplied is forced from the start; anything else is
// left open for the detector to fill in.
func newLanguagePin(userChoice string) *languagePin {
	p := &languagePin{}
	if code := normalizeLang(userChoice); code != "" {
		p.forced = code
		p.current = code
	}
	return p
}

// normalizeLang is a thin wrapper so the pin does not have to know where the
// normaliser lives.
func normalizeLang(raw string) string {
	return cloud.NormalizeLanguage(raw)
}

// observe records the language a chunk reported.
//
// It returns the language to send with the *next* request. A chunk that
// reported nothing changes nothing.
func (p *languagePin) observe(detected string) string {
	// The user's choice wins, always.
	if p.forced != "" {
		return p.forced
	}

	code := normalizeLang(detected)
	if code == "" {
		// Nothing to learn from this chunk. The agreement streak survives:
		// a chunk that did not report a language is not a chunk that
		// disagreed.
		return p.current
	}

	if code == p.candidate {
		p.agreements++
	} else {
		p.candidate = code
		p.agreements = 1
	}

	if p.current == "" && p.agreements >= agreementChunks {
		p.current = code
	}
	return p.current
}

// current returns the language in force.
func (p *languagePin) language() string {
	if p.forced != "" {
		return p.forced
	}
	return p.current
}

// forced reports whether the user chose this language.
func (p *languagePin) isForced() bool { return p.forced != "" }

// noteMismatch records that the text and the language disagree.
//
// The two cases are handled differently on purpose. A *forced* language is
// kept - the user asked for it, and a detector that disagrees with the user
// is the one that is wrong - but the disagreement is reported, because
// "you pinned English and the transcript came back in Devanagari" is
// exactly the situation the user needs to know about.
//
// An *auto-detected* language that the text contradicts is dropped: a wrong
// pin costs every remaining chunk, while no pin costs a little script
// consistency.
func (p *languagePin) noteMismatch(text string) {
	lang := p.language()
	if lang == "" {
		return
	}
	// Only a real conflict counts. Text in Latin under a Hindi pin is
	// Hinglish in Roman script - normal, and not a reason to touch the pin.
	if !script.Conflicts(text, lang) {
		return
	}
	verdict := script.Check(text, lang)

	if p.forced != "" {
		p.warning = verdict.Reason
		return
	}
	p.current = ""
	p.candidate = ""
	p.agreements = 0
	p.warning = verdict.Reason + " - language pin released, the next chunk is detected again"
}

// warningText returns the warning, if any.
func (p *languagePin) warningText() string { return strings.TrimSpace(p.warning) }
