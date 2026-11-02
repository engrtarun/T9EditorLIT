package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// AnalyzePrompt is the instruction sent to Gemini.
//
// The goal is NOT to write prose about the video. It is to produce a verdict
// per line that the Cut Panel can render directly as ✕ / ✓ marks, so the
// response format is a strict JSON contract rather than free text.
//
// It deliberately does not assume a Hindi coding tutorial: the previous wording
// ("in the style of Apna College and Coder Army") was applied to every import,
// so a plain English screen recording was judged against a Hinglish presenter's
// habits. The language rule below is what keeps the verdicts honest.
const AnalyzePrompt = `You are editing notes for a long spoken recording — a tutorial, a stream
or a podcast — with one presenter thinking out loud.

You will receive transcript lines, each with an id, start_secs, end_secs and text.
The transcript may be Hindi, Hinglish, English or a mix. Judge what was said,
not which language it was said in, and answer in whatever language the transcript
is already using.

For EACH line decide one verdict:

- "silence"       : nothing meaningful is said; dead air, long pause, or the
                    presenter just trails off mid-thought.
- "fumble"        : the presenter stumbles, starts a word and abandons it, or
                    the sentence is incoherent.
- "retake"        : the presenter says something and then immediately restarts
                    the SAME sentence more clearly. Mark the EARLIER, botched
                    take only. The corrected repeat must be kept.
- "wrong_example" : the presenter gives an example, realises it is wrong, and
                    says so in words (e.g. "ye galat ho gaya", "dobara batata
                    hu", "sorry, mistake", "that was wrong, let me redo it").
                    Mark that whole example block.
- "none"          : normal, usable speech. Keep it.

Rules:
- Be conservative. A false cut is far more expensive than a missed cut,
  because the presenter has to notice and undo it manually.
- When the same idea is retried, mark ONLY the earlier attempt. Never mark the
  final, clearest delivery.
- Do not cut stylistic pauses, "matlab", fillers like "toh" or "basically",
  or silence that is under 1.5 seconds.
- Use the tone profile to tell an intentional restatement apart from a stumble.

Reply with ONLY a JSON array, no prose and no code fence, like:
[{"id":"...","flag":"retake","reason":"stumbled, then redid the sentence"}]

If every line is fine, reply with an empty array [].`

// AnalysisBatchSize is how many transcript lines travel in one Gemini call.
//
// Everything used to go in a single prompt, which silently broke every video
// longer than the model's context: the tail of a two-hour transcript was cut
// off, so lines past the limit were never judged and came back unflagged. A
// batch is small enough to fit with room for the reply, and the job now reports
// progress per batch instead of sitting at 0%.
const AnalysisBatchSize = 120

// Analysis is one line's verdict.
type Analysis struct {
	ID     string     `json:"id"`
	Flag   model.Flag `json:"flag"`
	Reason string     `json:"reason,omitempty"`
}

// Analyze asks the model to flag lines and returns per-line verdicts.
//
// The model is given the tone profile and creator handle so its notion of
// "normal delivery" matches this presenter rather than a generic speaker.
func (c *GeminiClient) Analyze(
	ctx context.Context,
	segments []model.Segment,
	toneProfile string,
	creatorHandle string,
) ([]Analysis, error) {
	return c.AnalyzeProgress(ctx, segments, toneProfile, creatorHandle, nil)
}

// AnalyzeProgress is Analyze with a per-batch progress hook.
//
// A failed batch does not sink the job: the lines it covers keep their default
// "keep", and the rest of the transcript still gets judged. Returning an error
// alongside usable verdicts is the same contract CorrectSegments uses, and the
// API layer turns it into a partial job rather than a failed one.
func (c *GeminiClient) AnalyzeProgress(
	ctx context.Context,
	segments []model.Segment,
	toneProfile string,
	creatorHandle string,
	onBatch func(done, total int),
) ([]Analysis, error) {
	if len(segments) == 0 {
		return nil, nil
	}

	totalBatches := (len(segments) + AnalysisBatchSize - 1) / AnalysisBatchSize
	var out []Analysis
	var failures []string
	done := 0

	for start := 0; start < len(segments); start += AnalysisBatchSize {
		end := start + AnalysisBatchSize
		if end > len(segments) {
			end = len(segments)
		}

		verdicts, err := c.analyzeBatch(ctx, segments[start:end], toneProfile, creatorHandle)
		if err != nil {
			failures = append(failures, fmt.Sprintf("lines %d-%d: %v", start+1, end, err))
		} else {
			out = append(out, verdicts...)
		}

		done++
		if onBatch != nil {
			onBatch(done, totalBatches)
		}
	}

	if len(failures) > 0 {
		return out, fmt.Errorf("%d of %d analysis batches failed: %s",
			len(failures), totalBatches, strings.Join(failures, "; "))
	}
	return out, nil
}

// analyzeBatch judges one batch of transcript lines.
func (c *GeminiClient) analyzeBatch(
	ctx context.Context,
	segments []model.Segment,
	toneProfile string,
	creatorHandle string,
) ([]Analysis, error) {
	if len(segments) == 0 {
		return nil, nil
	}

	var sb strings.Builder
	sb.WriteString(AnalyzePrompt)

	if toneProfile != "" {
		sb.WriteString("\n\nTONE PROFILE:\n")
		sb.WriteString(toneProfile)
	}
	if creatorHandle != "" {
		sb.WriteString("\n\nPRESENTER: ")
		sb.WriteString(creatorHandle)
		sb.WriteString("\nReference their published videos for delivery style.")
	}

	sb.WriteString("\n\nTRANSCRIPT LINES:\n")
	for _, s := range segments {
		fmt.Fprintf(&sb, "\n%s\t%.3f\t%.3f\t%s\n",
			s.ID, s.StartSecs, s.EndSecs, strings.TrimSpace(s.Text))
	}

	raw, err := c.GenerateText(ctx, sb.String())
	if err != nil {
		return nil, err
	}
	return ParseAnalysis(raw)
}

// fenceRe strips a ```json ... ``` wrapper, which Gemini adds often enough
// that assuming it is absent is not safe.
var fenceRe = regexp.MustCompile("(?s)```(?:json)?\\s*(.*?)\\s*```")

// ParseAnalysis extracts the JSON array from a model response.
//
// Gemini occasionally prepends prose or wraps the array in a code fence, so
// this is deliberately forgiving: strip fences, then take the outermost array.
// Anything still unparseable returns an error rather than a silent empty
// result, because "no cuts found" and "the model failed" must not look alike.
func ParseAnalysis(raw string) ([]Analysis, error) {
	s := strings.TrimSpace(raw)
	s = fenceRe.ReplaceAllString(s, "$1")

	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start == -1 || end == -1 || end < start {
		return nil, fmt.Errorf("no JSON array found in model response: %q", truncate(s, 200))
	}

	var out []Analysis
	if err := json.Unmarshal([]byte(s[start:end+1]), &out); err != nil {
		return nil, fmt.Errorf("decode analysis JSON: %w", err)
	}

	// Drop anything with an unusable flag — a hallucinated value would render
	// as an unknown state in the UI.
	cleaned := out[:0]
	for _, a := range out {
		if a.ID == "" || !a.Flag.Valid() {
			continue
		}
		cleaned = append(cleaned, a)
	}
	return cleaned, nil
}

// ApplyAnalysis merges verdicts onto the transcript.
//
// It returns a NEW slice; the input is not mutated, so the caller can still
// present the original transcript if the user wants to override the AI.
func ApplyAnalysis(segments []model.Segment, analyses []Analysis) []model.Segment {
	byID := make(map[string]Analysis, len(analyses))
	for _, a := range analyses {
		byID[a.ID] = a
	}

	out := make([]model.Segment, len(segments))
	for i, s := range segments {
		out[i] = s
		// Default is keep, matching the "nothing is lost by accident" rule.
		out[i].Keep = true
		out[i].Flag = model.FlagNone

		if a, ok := byID[s.ID]; ok {
			out[i].Flag = a.Flag
			out[i].Reason = a.Reason
			out[i].Keep = a.Flag == model.FlagNone
		}
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
