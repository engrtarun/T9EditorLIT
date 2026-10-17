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
	GeminiBaseURL     = "https://generativelanguage.googleapis.com/v1beta/models"
)

// GroqClient talks to Groq's OpenAI-compatible transcription endpoint.
type GroqClient struct {
	APIKey string
	Model  string
	// URL is overridable so tests can target an httptest server.
	URL  string
	HTTP *http.Client
}

// NewGroq builds a client with sensible timeouts.
//
// The timeout is generous because Whisper Large v3 on a long chunk can take
// tens of seconds; the queue's own backoff handles the retry story.
func NewGroq(apiKey, model, endpoint string) *GroqClient {
	if endpoint == "" {
		endpoint = "https://api.groq.com/openai/v1/audio/transcriptions"
	}
	return &GroqClient{
		APIKey: apiKey,
		Model:  model,
		URL:    endpoint,
		HTTP:   &http.Client{Timeout: 180 * time.Second},
	}
}

type groqResponse struct {
	Text     string        `json:"text"`
	Language string        `json:"language"`
	Segments []groqSegment `json:"segments"`
}

type groqSegment struct {
	ID    int     `json:"id"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Text  string  `json:"text"`
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
		})
	}

	return segments, nil
}

// round3 trims float noise so timestamps round-trip predictably through JSON.
func round3(v float64) float64 {
	return float64(int64(v*1000+0.5)) / 1000
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
