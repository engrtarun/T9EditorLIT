// Package cloud — merge.go: two readings, one best transcript.
//
// The accuracy mode transcribes every chunk TWICE — ElevenLabs (primary) and
// Groq Whisper (secondary) — and gives Gemini both readings to reconcile.
// Two engines hear the same audio differently: one catches a word the other
// slurs, one handles Hinglish code-switching better, one invents a stock
// phrase over music. Where they agree, the text is almost certainly right;
// where they differ, a model that can read both — with timestamps — usually
// picks the true one. Measured against either engine alone, that is the
// accuracy gain the user asked for.
//
// The merge happens per chunk, with chunk-relative seconds, so a two-hour
// video costs the same prompt size per call as a one-minute one. Gemini
// returns JSON lines with the same relative clock; the server shifts them
// back onto the video's timeline and attaches the primary engine's word
// timings, so a split still cuts text, not only time.
//
// Failure rule: the merge is a bonus, never a dependency. Any Gemini problem
// — missing key, rate limit, unreadable answer — degrades to the primary
// transcript, and the job moves on.
package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// mergeLine is one transcript line as it travels to and from Gemini: a
// chunk-relative window and its text. The chunk-relative clock keeps the
// numbers small and identical between the two inputs, which is what lets the
// model see that both readings describe the same span.
type mergeLine struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
}

const mergeInstruction = `You reconcile two machine transcripts of the SAME audio recording into one best transcript.

Rules:
- Where the readings agree, that text is correct: keep it.
- Where they differ, choose the wording most likely to have been SPOKEN, using context. Do not merge both readings into a longer sentence.
- Never translate. Never invent words that appear in neither reading. Keep the original script (Hinglish stays Roman script if the readings use Roman script, Devanagari if they do not).
- Every output line needs a time window from the input readings. You may merge adjacent lines when both readings show one continuous sentence, but never widen a window beyond the readings.
- Lines must be ordered by start time and must not overlap.
- If one reading is empty, copy the other. If both are empty, output [].

Output ONLY a JSON array of objects with the keys "start", "end" and "text" (seconds as numbers). No prose, no code fence.`

// BuildMergePrompt renders both readings. The engine labels matter: Gemini
// is told which reading to prefer on a genuine tie, and the primary is the
// engine the user picked to be better.
func BuildMergePrompt(primary, secondary []mergeLine) string {
	pri, _ := json.Marshal(primary)
	sec, _ := json.Marshal(secondary)
	var sb strings.Builder
	sb.WriteString(mergeInstruction)
	sb.WriteString("\n\nTranscript A (PRIMARY reading, prefer on ties):\n")
	sb.Write(pri)
	sb.WriteString("\n\nTranscript B (SECONDARY reading):\n")
	sb.Write(sec)
	return sb.String()
}

// ParseMergeLines reads the model's answer. Real models wrap JSON in code
// fences or drop a sentence of preamble, so the parser finds the outermost
// array and parses just that — the same tolerance ParseCorrections uses.
func ParseMergeLines(out string) ([]mergeLine, error) {
	s := strings.TrimSpace(out)
	if s == "" {
		return nil, fmt.Errorf("gemini returned an empty merge")
	}
	if i := strings.Index(s, "["); i >= 0 {
		if j := strings.LastIndex(s, "]"); j > i {
			s = s[i : j+1]
		}
	}
	var lines []mergeLine
	if err := json.Unmarshal([]byte(s), &lines); err != nil {
		return nil, fmt.Errorf("merge answer is not a JSON array: %w", err)
	}

	clean := make([]mergeLine, 0, len(lines))
	for _, l := range lines {
		text := strings.TrimSpace(l.Text)
		if text == "" {
			continue
		}
		if l.End < l.Start {
			l.Start, l.End = l.End, l.Start
		}
		if l.Start < 0 {
			l.Start = 0
		}
		if l.End < l.Start {
			l.End = l.Start
		}
		clean = append(clean, mergeLine{Start: round3(l.Start), End: round3(l.End), Text: text})
	}
	if len(clean) == 0 {
		return nil, fmt.Errorf("merge answer had no lines")
	}
	sort.SliceStable(clean, func(i, j int) bool { return clean[i].Start < clean[j].Start })
	return clean, nil
}

// LinesFromSegments projects a chunk transcript onto the chunk-relative clock
// for the prompt.
func LinesFromSegments(segs []model.Segment, offsetSecs float64) []mergeLine {
	lines := make([]mergeLine, 0, len(segs))
	for _, s := range segs {
		text := strings.TrimSpace(s.Text)
		if text == "" {
			continue
		}
		lines = append(lines, mergeLine{
			Start: round3(s.StartSecs - offsetSecs),
			End:   round3(s.EndSecs - offsetSecs),
			Text:  text,
		})
	}
	return lines
}

// MergeChunkTranscripts runs one reconciliation. Both inputs are ALREADY on
// the video's absolute timeline; the offset is subtracted for the prompt and
// added back on the way out, so the caller never sees two clocks.
//
// The primary's word timings are attached to the merged lines by midpoint, so
// the editor keeps cutting text. A merged line that straddles words still
// works — attachWordsToSegments fills what it can and leaves the rest alone.
func (c *GeminiClient) MergeChunkTranscripts(
	ctx context.Context,
	offsetSecs float64,
	primary, secondary ChunkTranscript,
) ([]model.Segment, error) {
	pri := LinesFromSegments(primary.Segments, offsetSecs)
	sec := LinesFromSegments(secondary.Segments, offsetSecs)
	if len(pri) == 0 && len(sec) == 0 {
		return nil, fmt.Errorf("both readings are empty; nothing to merge")
	}

	out, err := c.GenerateText(ctx, BuildMergePrompt(pri, sec))
	if err != nil {
		return nil, err
	}
	lines, err := ParseMergeLines(out)
	if err != nil {
		return nil, err
	}

	idBase := fmt.Sprintf("%d", int(offsetSecs*1000))
	segments := make([]model.Segment, 0, len(lines))
	for i, l := range lines {
		segments = append(segments, model.Segment{
			ID:        idBase + "-" + fmt.Sprint(i),
			StartSecs: round3(l.Start + offsetSecs),
			EndSecs:   round3(l.End + offsetSecs),
			Text:      l.Text,
			Flag:      model.FlagNone,
			Keep:      true,
		})
	}

	// Word timings come from the primary reading: it is the engine the user
	// trusted, and its words are already on the absolute timeline.
	var words []model.Word
	for _, s := range primary.Segments {
		words = append(words, s.Words...)
	}
	attachWordsToSegments(segments, words)

	return segments, nil
}
