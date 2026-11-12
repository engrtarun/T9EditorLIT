package cloud

// Translation of an existing transcript into a second language.
//
// This is the "view, do not replace" half of the language story. The edge
// case it answers is a rare language whose translation quality is poor, or a
// Hinglish recording the user wants to read in English: in both cases the
// source text has to stay the primary, because the source text is what was
// actually said and what the cut decisions are made on.
//
// So the pass never touches Segment.Text. It fills Segment.TranslatedText
// and names the provider in Segment.TranslationSource, and the UI shows the
// translation underneath the original with a badge. If the translation is
// wrong, the user reads the original; nothing was lost.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// TranslatePrompt is the instruction sent to the model.
//
// Two rules do the work. "Translate meaning, do not rewrite" keeps the pass
// from summarising - a translator that drops half a sentence is worse than no
// translator, because the user cannot tell which half is missing. "Return
// the line unchanged when it is already in the target language" keeps an
// English source from being paraphrased into different English.
const TranslatePrompt = `You translate transcript lines of a spoken recording.

Translate each line into %s. Keep the meaning exactly as spoken: same facts, same
numbers, same names, same technical terms. Do not summarise, do not add
explanations, and do not make the line more fluent than it was spoken.

- A line that is already in %s comes back unchanged.
- Technical terms, product names, code identifiers and channel handles stay as they are.
- Keep the line's punctuation style and its length close to the original.

Reply with ONLY a JSON array of objects, in the same order as the input, one per line:
[{"i":0,"text":"the translation"}]

Use the "i" value from the input line. If a line cannot be translated, return it unchanged.`

// TranslationBatchSize is how many lines travel in one request.
//
// Twenty lines is small enough that a rare-language line with a lot of
// context still fits, and large enough that a 350-line transcript is not
// twenty round trips.
const TranslationBatchSize = 20

// Translation is one line's rendering in the target language.
type Translation struct {
	// I is the index of the line within the batch, echoed back from the model.
	I int `json:"i"`
	// Text is the translation.
	Text string `json:"text"`
}

// TranslateSegments renders a transcript in the target language.
//
// The return value is a new slice; the input is never mutated, so the caller
// still holds the source text and can fall back to it. A per-batch failure
// is not fatal: that batch keeps its source text and the rest of the
// transcript is still translated.
func (c *GeminiClient) TranslateSegments(
	ctx context.Context,
	segments []model.Segment,
	target string,
) ([]model.Segment, error) {
	return c.TranslateSegmentsProgress(ctx, segments, target, nil)
}

// TranslateSegmentsProgress is TranslateSegments with a per-batch progress
// hook, so the UI can show the pass moving instead of sitting at 0%.
func (c *GeminiClient) TranslateSegmentsProgress(
	ctx context.Context,
	segments []model.Segment,
	target string,
	onBatch func(done, total int),
) ([]model.Segment, error) {
	out := make([]model.Segment, len(segments))
	copy(out, segments)
	if len(out) == 0 {
		return out, nil
	}

	target = strings.TrimSpace(target)
	if target == "" {
		target = "en"
	}

	totalBatches := (len(segments) + TranslationBatchSize - 1) / TranslationBatchSize
	var failures []string
	done := 0

	for start := 0; start < len(segments); start += TranslationBatchSize {
		end := start + TranslationBatchSize
		if end > len(segments) {
			end = len(segments)
		}

		batch := segments[start:end]
		translations, err := c.translateBatch(ctx, batch, target)
		if err != nil {
			failures = append(failures, fmt.Sprintf("lines %d-%d: %v", start+1, end, err))
		} else {
			applyTranslations(out[start:end], translations)
		}

		done++
		if onBatch != nil {
			onBatch(done, totalBatches)
		}
	}

	if len(failures) > 0 {
		return out, fmt.Errorf("%d of %d translation batches failed: %s",
			len(failures), totalBatches, strings.Join(failures, "; "))
	}
	return out, nil
}

// translateBatch sends one batch and parses the reply.
func (c *GeminiClient) translateBatch(
	ctx context.Context,
	batch []model.Segment,
	target string,
) ([]Translation, error) {
	var sb strings.Builder
	fmt.Fprintf(&sb, "LINES\n")
	for i, s := range batch {
		fmt.Fprintf(&sb, "%d\t%s\n", i, strings.TrimSpace(s.Text))
	}

	raw, err := c.GenerateText(ctx, fmt.Sprintf(TranslatePrompt, target, target)+"\n\n"+sb.String())
	if err != nil {
		return nil, err
	}
	return ParseTranslations(raw)
}

// applyTranslations writes the model's text onto the translated field.
//
// Every guard here is a refusal to mislabel a line. An out-of-range index, a
// count mismatch or an empty string leaves the line untranslated - the UI
// then shows the source text alone, which is correct, instead of a
// translation that belongs to a different line.
func applyTranslations(dst []model.Segment, translations []Translation) {
	byIndex := make(map[int]string, len(translations))
	for _, t := range translations {
		text := strings.TrimSpace(t.Text)
		if text == "" {
			continue
		}
		byIndex[t.I] = text
	}

	// The reply has to line up exactly: a missing, duplicated or empty entry
	// means every index after it points at the wrong line. A count alone is
	// not enough - two entries for lines 0 and 5 of a two-line batch have the
	// right count and the wrong meaning - so the index set has to be exactly
	// 0..n-1.
	if len(byIndex) != len(dst) {
		return
	}
	for i := range dst {
		if _, ok := byIndex[i]; !ok {
			return
		}
	}

	for i := range dst {
		text, ok := byIndex[i]
		if !ok {
			continue
		}
		dst[i].TranslatedText = text
		dst[i].TranslationSource = "gemini"
	}
}

// ParseTranslations reads the model's JSON array of translations.
//
// Forgiving in the same way ParseCorrections is: strip a code fence, then
// take the outermost array. A response with no array is an error rather than
// an empty slice, so "nothing needed translating" and "the model failed"
// stay distinguishable.
func ParseTranslations(raw string) ([]Translation, error) {
	s := strings.TrimSpace(raw)
	s = fenceRe.ReplaceAllString(s, "$1")

	start := strings.Index(s, "[")
	end := strings.LastIndex(s, "]")
	if start == -1 || end == -1 || end < start {
		return nil, fmt.Errorf("no JSON array found in translation response: %q", truncate(s, 200))
	}

	var out []Translation
	if err := json.Unmarshal([]byte(s[start:end+1]), &out); err != nil {
		return nil, fmt.Errorf("decode translation JSON: %w", err)
	}
	return out, nil
}
