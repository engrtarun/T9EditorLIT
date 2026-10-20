// Package cloud holds the provider clients.
//
// Design constraint shared by every client here: a chunk is STREAMED to the
// provider, never read into memory first. Groq caps uploads at 25 MB and a
// 2-hour video splits into dozens of chunks, so buffering even one chunk plus
// a retry would show up as a memory spike on an 8 GB machine.
package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// APIError carries an HTTP status so the queue can decide on retrying.
type APIError struct {
	Status  int
	Body    string
	Service string
}

func (e *APIError) Error() string {
	body := strings.TrimSpace(e.Body)
	if len(body) > 400 {
		body = body[:400] + "…"
	}
	return fmt.Sprintf("%s returned %d: %s", e.Service, e.Status, body)
}

// Retryable reports whether the failure is worth another attempt.
//
// 429 and 5xx are transient. Every other 4xx is the caller's fault — a bad API
// key or an oversized chunk will fail identically forever, and retrying just
// burns the provider's rate limit.
func (e *APIError) Retryable() bool {
	return e.Status == http.StatusTooManyRequests || e.Status >= 500
}

// IsRetryable extracts the retry decision from an error, defaulting to false
// for errors we do not recognise.
func IsRetryable(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.Retryable()
	}
	// Transport failures (connection reset, DNS, timeout) are worth retrying.
	return errors.Is(err, context.DeadlineExceeded) || isNetError(err)
}

func isNetError(err error) bool {
	if err == nil {
		return false
	}
	// A tiny heuristic that avoids importing net for one type check: net errors
	// always carry an op/timeout signature in their message.
	s := err.Error()
	return strings.Contains(s, "connection refused") ||
		strings.Contains(s, "connection reset") ||
		strings.Contains(s, "no such host")
}

// ── Groq ────────────────────────────────────────────────────────────────

// Provider endpoints. Overridable per-client so tests can point at an
// httptest server instead of hitting the live APIs.
const (
	GroqTranscribeURL = "https://api.groq.com/openai/v1/audio/transcriptions"
	// GroqChatURL is the OpenAI-compatible text endpoint, used for the
	// autocorrect pass. Same key and same account as Whisper.
	GroqChatURL   = "https://api.groq.com/openai/v1/chat/completions"
	GeminiBaseURL = "https://generativelanguage.googleapis.com/v1beta/models"
)

// GroqClient talks to Groq's OpenAI-compatible transcription endpoint.
type GroqClient struct {
	APIKey string
	Model  string
	// ChatModel is the text model behind the autocorrect pass. Empty disables
	// it, which is the state a daemon built with only a transcribe key is in.
	ChatModel string
	// URL and ChatURL are overridable so tests can target an httptest server.
	URL     string
	ChatURL string
	HTTP    *http.Client
}

// NewGroq builds a client with sensible timeouts.
//
// The timeout is generous because Whisper Large v3 on a long chunk can take
// tens of seconds; the queue's own backoff handles the retry story.
func NewGroq(apiKey, model, chatModel, endpoint string) *GroqClient {
	if endpoint == "" {
		endpoint = GroqTranscribeURL
	}
	return &GroqClient{
		APIKey:    apiKey,
		Model:     model,
		ChatModel: chatModel,
		URL:       endpoint,
		ChatURL:   GroqChatURL,
		HTTP:      &http.Client{Timeout: 180 * time.Second},
	}
}

type groqResponse struct {
	Text     string        `json:"text"`
	Language string        `json:"language"`
	Segments []groqSegment `json:"segments"`
	// Some Groq builds put the word list at the top level instead of inside
	// each segment. Both are read; per-segment wins.
	Words []groqWord `json:"words"`
}

type groqSegment struct {
	ID    int     `json:"id"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
	// Word-level timings, present when the request asked for word granularity.
	Words []groqWord `json:"words"`
}

type groqWord struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// TranscribeChunk uploads one audio chunk and returns its segments with times
// shifted into the original video's timeline.
//
// offsetSecs is where this chunk began; Groq reports times relative to the
// chunk, so without this the transcript for a 2-hour video would restart at
// zero after every chunk.
func (c *GroqClient) TranscribeChunk(
	ctx context.Context,
	chunkPath string,
	offsetSecs float64,
	language string,
	prompt string,
) ([]model.Segment, error) {
	f, err := os.Open(chunkPath)
	if err != nil {
		return nil, fmt.Errorf("open chunk %s: %w", filepath.Base(chunkPath), err)
	}
	defer f.Close()

	// io.Pipe streams the multipart body: the chunk is read in fixed-size
	// blocks and never held whole in memory.
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)

	go func() {
		// Order matters: finish the multipart body, close the writer to signal
		// EOF to the HTTP transport, and only THEN drain and close the reader.
		// Draining first would block forever waiting for data that can never
		// arrive, because the writer is still open.
		var writeErr error

		defer func() {
			_ = mw.Close()

			// Only the writer half is closed here. Closing the reader too would
			// race the HTTP transport's own read and surface as
			// "io: read/write on closed pipe". Closing the writer is what
			// signals EOF; the transport then finishes reading and the caller
			// closes the reader via the request lifecycle.
			pw.CloseWithError(writeErr)
		}()

		if writeErr = mw.WriteField("model", c.Model); writeErr != nil {
			return
		}
		// verbose_json is what produces per-segment timestamps. The default
		// response format returns one flat string with no timing at all.
		if writeErr = mw.WriteField("response_format", "verbose_json"); writeErr != nil {
			return
		}
		// Word granularity is what makes a split cut the *text* as well as the
		// timeline. Without it the editor can only cut time.
		if writeErr = mw.WriteField("timestamp_granularities[]", "word"); writeErr != nil {
			return
		}
		if language != "" {
			if writeErr = mw.WriteField("language", language); writeErr != nil {
				return
			}
		}
		if prompt != "" {
			if writeErr = mw.WriteField("prompt", prompt); writeErr != nil {
				return
			}
		}

		part, err := mw.CreateFormFile("file", filepath.Base(chunkPath))
		if err != nil {
			writeErr = err
			return
		}
		if _, err := io.Copy(part, f); err != nil {
			writeErr = err
		}
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, pr)
	if err != nil {
		return nil, fmt.Errorf("build groq request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("groq request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("read groq response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, &APIError{Status: resp.StatusCode, Body: string(body), Service: "groq"}
	}

	var parsed groqResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode groq response: %w", err)
	}

	segments := make([]model.Segment, 0, len(parsed.Segments))
	for i, s := range parsed.Segments {
		text := strings.TrimSpace(s.Text)
		if text == "" {
			continue
		}
		segments = append(segments, model.Segment{
			ID:        fmt.Sprintf("%d-%d", int(offsetSecs*1000), i),
			StartSecs: round3(s.Start + offsetSecs),
			EndSecs:   round3(s.End + offsetSecs),
			Text:      text,
			Flag:      model.FlagNone,
			Keep:      true,
			Words:     shiftWords(s.Words, offsetSecs),
		})
	}

	// With word granularity Groq returns `segments: null` and one flat `words`
	// array instead. Regroup the words into lines so the rest of the pipeline
	// (autocorrect, analysis, the editor) always sees segments.
	if len(segments) == 0 && len(parsed.Words) > 0 {
		segments = segmentsFromWords(parsed.Words, offsetSecs)
	}

	return segments, nil
}

// segmentsFromWords rebuilds transcript lines from a flat word list.
//
// Word granularity is what makes a split cut the *text* as well as the
// timeline, but it costs the sentence segmentation. A new line starts when
// the speaker pauses, when the previous word ends a sentence, or when the line
// gets long enough that a transcript row would be unreadable.
func segmentsFromWords(words []groqWord, offsetSecs float64) []model.Segment {
	const (
		pauseBreak  = 0.7  // seconds of silence that end a line
		maxLineSecs = 14.0 // longest line we will produce
	)

	var out []model.Segment
	var cur []groqWord

	flush := func() {
		if len(cur) == 0 {
			return
		}
		parts := make([]string, 0, len(cur))
		for _, w := range cur {
			parts = append(parts, w.Word)
		}
		out = append(out, model.Segment{
			ID:        fmt.Sprintf("%d-%d", int(offsetSecs*1000), len(out)),
			StartSecs: round3(cur[0].Start + offsetSecs),
			EndSecs:   round3(cur[len(cur)-1].End + offsetSecs),
			Text:      strings.Join(parts, " "),
			Flag:      model.FlagNone,
			Keep:      true,
			Words:     shiftWords(cur, offsetSecs),
		})
		cur = nil
	}

	for _, w := range words {
		text := strings.TrimSpace(w.Word)
		if text == "" {
			continue
		}
		if len(cur) > 0 {
			prev := cur[len(cur)-1]
			gap := w.Start - prev.End
			span := w.End - cur[0].Start
			endsSentence := endsSentence(prev.Word)
			if gap >= pauseBreak || endsSentence || span >= maxLineSecs {
				flush()
			}
		}
		cur = append(cur, groqWord{Word: text, Start: w.Start, End: w.End})
	}
	flush()

	return out
}

// endsSentence reports whether a word closes a sentence, in Devanagari or
// Latin script.
func endsSentence(word string) bool {
	if word == "" {
		return false
	}
	// Compare runes, not bytes: the Devanagari danda is multi-byte.
	r := []rune(word)
	switch r[len(r)-1] {
	case '.', '!', '?', '।', '॥':
		return true
	}
	return false
}

// shiftWords moves a chunk's word timings into the original video's timeline.
//
// Groq reports word times relative to the chunk, so without the shift a
// two-hour video's transcript would restart at zero after every chunk — the
// same reason the segment times are shifted.
func shiftWords(words []groqWord, offsetSecs float64) []model.Word {
	if len(words) == 0 {
		return nil
	}
	out := make([]model.Word, 0, len(words))
	for _, w := range words {
		text := strings.TrimSpace(w.Word)
		if text == "" {
			continue
		}
		out = append(out, model.Word{
			Word:  text,
			Start: round3(w.Start + offsetSecs),
			End:   round3(w.End + offsetSecs),
		})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// round3 trims float noise so timestamps round-trip predictably through JSON.
func round3(v float64) float64 {
	return float64(int64(v*1000+0.5)) / 1000
}

// ── Groq text (autocorrect) ─────────────────────────────────────────────

// chatRequest is the OpenAI-compatible chat completions body.
//
// response_format is deliberately omitted: Groq's JSON mode is not available on
// every hosted model, and ParseCorrections already tolerates a code fence or a
// sentence of preamble. Asking for it would trade robustness for nothing.
type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens,omitempty"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

// Chat runs one prompt through Groq's text model.
//
// This is the autocorrect transport, not the transcription one. Whisper hears
// words phonetically and turns "JavaScript" into "javas cript"; a text model
// maps that back far more reliably than a second Whisper pass would, and it
// costs a fraction as much.
func (c *GroqClient) Chat(ctx context.Context, system, user string) (string, error) {
	// Deterministic: the same line must correct to the same text every run,
	// otherwise re-transcribing a video silently churns the transcript.
	return c.chat(ctx, c.ChatModel, system, user, 0, 8192)
}

// defaultGreetingModel is the model behind the dashboard line.
//
// It is deliberately NOT GROQ_CHAT_MODEL. That one is a reasoning model, and a
// creative prompt makes it spend the whole token budget thinking: measured on
// this key, gpt-oss-120b returned finish_reason "length" with 218 reasoning
// tokens and an empty completion, at both 220 and 700 max_tokens. qwen3 answers
// the same prompt in ~30 tokens with no reasoning pass - cheaper, faster, and
// it follows the "Roman script" rule.
//
// GROQ_GREETING_MODEL overrides it without touching the autocorrect model.
const defaultGreetingModel = "qwen/qwen3.8-27b"

func greetingModel() string {
	if m := strings.TrimSpace(os.Getenv("GROQ_GREETING_MODEL")); m != "" {
		return m
	}
	return defaultGreetingModel
}

// ChatCreative is the same transport with room to breathe: a little
// temperature so two calls do not return the same sentence, and a small token
// budget because these answers are one line, not a transcript.
func (c *GroqClient) ChatCreative(ctx context.Context, system, user string) (string, error) {
	return c.chat(ctx, greetingModel(), system, user, 0.8, 200)
}

func (c *GroqClient) chat(
	ctx context.Context,
	model, system, user string,
	temperature float64,
	maxTokens int,
) (string, error) {
	if model == "" {
		return "", errors.New("groq chat model is not configured (set GROQ_CHAT_MODEL)")
	}

	payload, err := json.Marshal(chatRequest{
		Model: model,
		Messages: []chatMessage{
			{Role: "system", Content: system},
			{Role: "user", Content: user},
		},
		Temperature: temperature,
		MaxTokens:   maxTokens,
	})
	if err != nil {
		return "", fmt.Errorf("encode groq chat request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.ChatURL, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build groq chat request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.APIKey)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("groq chat request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", fmt.Errorf("read groq chat response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", &APIError{Status: resp.StatusCode, Body: string(body), Service: "groq chat"}
	}

	var parsed chatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode groq chat response: %w", err)
	}
	// Groq reports some failures inside a 200 body, so this is checked before
	// the choices — otherwise the error surfaces as "returned no choices".
	if parsed.Error != nil && parsed.Error.Message != "" {
		return "", fmt.Errorf("groq chat: %s", parsed.Error.Message)
	}
	if len(parsed.Choices) == 0 {
		return "", errors.New("groq chat returned no choices")
	}

	out := strings.TrimSpace(parsed.Choices[0].Message.Content)
	if out == "" {
		return "", errors.New("groq chat returned an empty completion")
	}
	return out, nil
}

// ── Gemini ──────────────────────────────────────────────────────────────

// GeminiClient talks to the Google Generative Language API.
type GeminiClient struct {
	APIKey string
	Model  string
	// BaseURL is overridable so tests can target an httptest server.
	BaseURL string
	HTTP    *http.Client
}

// NewGemini builds a client.
func NewGemini(apiKey, model, baseURL string) *GeminiClient {
	if baseURL == "" {
		baseURL = "https://generativelanguage.googleapis.com/v1beta/models"
	}
	return &GeminiClient{
		APIKey:  apiKey,
		Model:   model,
		BaseURL: baseURL,
		HTTP:    &http.Client{Timeout: 120 * time.Second},
	}
}

type geminiRequest struct {
	Contents []geminiContent `json:"contents"`
}

type geminiContent struct {
	Parts []geminiPart `json:"parts"`
}

type geminiPart struct {
	Text string `json:"text"`
}

type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
}

// GenerateText sends a single prompt and returns the model's text.
func (c *GeminiClient) GenerateText(ctx context.Context, prompt string) (string, error) {
	url := fmt.Sprintf("%s/%s:generateContent", strings.TrimRight(c.BaseURL, "/"), c.Model)

	payload, err := json.Marshal(geminiRequest{
		Contents: []geminiContent{{Parts: []geminiPart{{Text: prompt}}}},
	})
	if err != nil {
		return "", fmt.Errorf("encode gemini request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build gemini request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", c.APIKey)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("gemini request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return "", fmt.Errorf("read gemini response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", &APIError{Status: resp.StatusCode, Body: string(body), Service: "gemini"}
	}

	var parsed geminiResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode gemini response: %w", err)
	}
	if len(parsed.Candidates) == 0 || len(parsed.Candidates[0].Content.Parts) == 0 {
		return "", errors.New("gemini returned no candidates")
	}

	var sb strings.Builder
	for _, p := range parsed.Candidates[0].Content.Parts {
		sb.WriteString(p.Text)
	}
	return strings.TrimSpace(sb.String()), nil
}
