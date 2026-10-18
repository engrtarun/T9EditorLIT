package cloud

// Autocorrect for the Whisper transcript.
//
// Whisper transcribes phonetically. On a Hinglish coding tutorial that produces
// "javas cript", "funk shun isay define karte hain", "phy ton me hum loop
// likhte hain" — the words are right and the spelling is not. Re-running
// Whisper does not fix that; a text model does, because it knows what
// "JavaScript" is supposed to look like.
//
// The pass is deliberately conservative. A line the model cannot confidently
// improve comes back byte-for-byte unchanged, because a wrong guess is
// indistinguishable from a transcription and the user has no way to tell them
// apart. See CorrectSegments for the guards that enforce this.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// CorrectPrompt is the instruction sent to the text model.
//
// Two rules do the heavy lifting. "Fix spelling and punctuation only" keeps
// the pass from rewriting the presenter into fluent prose, which would quietly
// change what the video says. "Return a line you cannot improve unchanged"
// makes abstention the default and correction the exception — the opposite of
// what an LLM wants to do, and exactly what is needed when the user has to
// trust the result.
const CorrectPrompt = `You clean up auto-generated transcripts for a Hindi-English (Hinglish) programming tutorial. Whisper heard the audio phonetically and misspelled many words. Your only job is to fix spelling and punctuation.

FIX
- Technical terms, language names and identifiers. Whisper splits them into syllables: "javas cript" -> "JavaScript", "type script" -> "TypeScript", "phy ton" -> "Python", "funk shun" -> "function", "vay ri able" -> "variable", "ar ray" -> "array", "ob jeekt" -> "object", "ap i" -> "API", "h t m l" -> "HTML", "c s s" -> "CSS", "r e act" -> "React", "node j s" -> "Node.js", "git h u b" -> "GitHub", "mon go d b" -> "MongoDB", "post gre" -> "PostgreSQL", "kaun ho" -> "console", "a say nc" -> "async", "pro mis" -> "Promise".
- Words that were split apart or run together.
- Roman-script Hindi spelling, written the way it is spoken: kya, nahi, kar, karte, karke, chalo, abhi, phir, bhi, dekho, samjho.

DO NOT CHANGE
- The language. This is Hinglish. Never translate Hindi into English or English into Hindi.
- The script. Roman/Latin letters only. Never output Devanagari.
- The wording, the slang and the filler words (toh, basically, matlab, yaar, ab).
- Numbers, values and code identifiers as they were spoken.
- If you cannot confidently improve a line, return that line exactly as given. A wrong guess is worse than the raw text, because the user cannot tell a guess from a transcription.

Add natural punctuation and capital letters where a sentence clearly starts. Do not add words.

Reply with ONLY a JSON array of objects, in the same order as the input, one per line:
[{"i":0,"text":"the corrected line"}]

Use the "i" value from the input line. If a line needs no change, still include it with its original text.`

// Correction is one line's cleaned-up text.
type Correction struct {
	// I is the index of the line within the batch, echoed back from the model.
	I int `json:"i"`
	// Text is the corrected line.
	Text string `json:"text"`
}

// CorrectionBatchSize is how many lines travel in one request.
//
// Thirty lines is roughly 1.5k tokens in and 2k out, which sits comfortably
// inside every hosted model's context while keeping the number of round trips
// low. A two-hour video is a few dozen batches, and they run sequentially
// because Groq's rate limit — not this machine — is the bottleneck.
const CorrectionBatchSize = 30

// maxGrowthRatio caps how much longer a corrected line may be than its source.
//
// The model is told not to rewrite, so anything past this is a red flag for a
// generation that ran away rather than a correction. Silently falling back to
// the original beats shipping a paragraph where a sentence belongs.
const maxGrowthRatio = 4

// minCorrectionGrowth is the absolute slack every line gets on top of the
// ratio, so a very short source line is not held to an impossible bound.
const minCorrectionGrowth = 8

// CorrectSegments fixes Whisper's spelling across a whole transcript.
//
// The return value is a new slice; the input is never mutated, so the caller
// still holds the raw Whisper output and can fall back to it. A per-batch
// failure is not fatal: that batch keeps its original text and the rest of the
// transcript is still corrected, because 90% corrected beats 0% corrected when
// the alternative is re-running a fifteen-minute transcription.
func (c *GroqClient) CorrectSegments(
	ctx context.Context,
	segments []model.Segment,
) ([]model.Segment, error) {
	out := make([]model.Segment, len(segments))
	copy(out, segments)
	if len(segments) == 0 {
		return out, nil
	}

	var failures []string
	for start := 0; start < len(segments); start += CorrectionBatchSize {
		end := start + CorrectionBatchSize
		if end > len(segments) {
			end = len(segments)
		}

		batch := segments[start:end]
		corrections, err := c.correctBatch(ctx, batch)
		if err != nil {
			failures = append(failures, fmt.Sprintf("lines %d-%d: %v", start+1, end, err))
			continue
		}
		applyCorrections(out[start:end], batch, corrections)
	}

	if len(failures) > 0 {
		return out, fmt.Errorf("%d of %d batches failed: %s",
			len(failures), (len(segments)+CorrectionBatchSize-1)/CorrectionBatchSize,
			strings.Join(failures, "; "))
	}
	return out, nil
}

// correctBatch sends one batch and parses the reply.
func (c *GroqClient) correctBatch(
	ctx context.Context,
	batch []model.Segment,
) ([]Correction, error) {
	var sb strings.Builder
	sb.WriteString("LINES\n")
	for i, s := range batch {
		// The index is in the prompt as well as the id, because the id is an
		// opaque "<offsetMs>-<n>" string that models paraphrase when echoing
		// it back. A positional index is too small to get wrong.
		fmt.Fprintf(&sb, "%d\t%s\n", i, strings.TrimSpace(s.Text))
	}

	raw, err := c.Chat(ctx, CorrectPrompt, sb.String())
	if err != nil {
		return nil, err
	}
	return ParseCorrections(raw)
}

// applyCorrections writes the model's text back, one line at a time.
//
// Every guard here is a refusal to make the transcript worse. An out-of-range
// index, a count mismatch, an empty string or a runaway expansion all leave
// the original line in place — the pass is an improvement, never a dependency.
func applyCorrections(dst, src []model.Segment, corrections []Correction) {
	byIndex := make(map[int]string, len(corrections))
	for _, c := range corrections {
		text := strings.TrimSpace(c.Text)
		if text == "" {
			continue
		}
		byIndex[c.I] = text
	}

	// The reply has to line up exactly: a missing, duplicated or empty entry
	// means every index after it is now pointing at the wrong line, and
	// silently shifting a transcript by one is far worse than skipping the
	// batch. Verified against a count, not just a per-line lookup.
	if len(byIndex) != len(src) {
		return
	}

	for i, s := range src {
		text, ok := byIndex[i]
		if !ok {
			continue
		}
		// A runaway generation reads as a rewrite, not a correction.
		// The floor stops an empty or near-empty source line from
		// multiplying out to a limit of zero, which would reject every
		// correction to a short line.
		if limit := max(len(s.Text)*maxGrowthRatio, len(s.Text)+minCorrectionGrowth); len(text) > limit {
			continue
		}
		// The correction always applies — a gained full stop is a genuine
		// improvement. OriginalText is the *report* of it, and only goes on
		// for changes worth showing. See worthReporting.
		dst[i].Text = text
		if worthReporting(text, s.Text) {
			dst[i].OriginalText = s.Text
		}
	}
}

// worthReporting decides whether a correction is worth telling the user about.
//
// A full stop and a capital letter are real changes and the caller keeps them
// either way. What is filtered here is the *report*: a dot next to a line that
// only gained a full stop turns "40 spelling fixes" into a number that means
// nothing, and the hover tooltip has nothing useful to show. The two tests
// cover the cases that actually show up — a case-only difference, and a line
// whose words are identical once punctuation is stripped.
func worthReporting(corrected, original string) bool {
	if corrected == original {
		return false
	}
	if strings.EqualFold(corrected, original) {
		return false
	}
	return stripPunctuation(corrected) != stripPunctuation(original)
}

// punctuation is the set of marks autocorrect is allowed to add, because a
// spoken sentence has none and the model supplies them.
//
// It is deliberately narrow. Brackets and dashes are excluded — "array[0]" and
// "well-known" are content, and stripping them would hide a real change.
const punctuation = ".!?;:,"

// stripPunctuation removes case and trailing punctuation for comparison only.
func stripPunctuation(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if strings.ContainsRune(punctuation, r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// ParseCorrections reads the model's JSON array of corrections.
//
// Forgiving in the same way ParseAnalysis is: strip a code fence, then take the
// outermost array. A response with no array is an error rather than an empty
// slice, so "the model returned nothing" and "nothing needed fixing" stay
// distinguishable.
func ParseCorrections(raw string) ([]Correction, error) {
	s := strings.TrimSpace(raw)
	s = fenceRe.ReplaceAllString(s, "$1")

	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start == -1 || end == -1 || end < start {
		return nil, fmt.Errorf("no JSON array found in correction response: %q", truncate(s, 200))
	}

	var out []Correction
	if err := json.Unmarshal([]byte(s[start:end+1]), &out); err != nil {
		return nil, fmt.Errorf("decode correction JSON: %w", err)
	}
	return out, nil
}
