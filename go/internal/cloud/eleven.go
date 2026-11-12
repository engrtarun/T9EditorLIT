// Package cloud — eleven.go: the primary transcriber.
//
// ElevenLabs Scribe is the engine the user pays with a POOL of free accounts.
// This client mirrors GroqClient.TranscribeChunkResult's contract exactly —
// same ChunkTranscript, same chunk-relative-to-absolute time shift, same
// zero-RAM streaming — so runTranscribe can use either engine (or both, for
// the Gemini ensemble) without the pipeline knowing the difference.
//
// What is different is the credential handling. Groq has one key; ElevenLabs
// has a pool. Every request asks the pool for the best account, and every
// outcome is reported back so a rate-limited account cools down while the
// others carry the load. When a key-level failure happens (429, 401, 402) the
// client rotates to the NEXT account within the same chunk instead of
// failing the chunk — the queue's job retry is for real failures, not for
// account juggling the pool can do itself.
package cloud

import (
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
)

// Provider endpoints, overridable per-client so tests can point at an
// httptest server.
const (
	ElevenTranscribeURL   = "https://api.elevenlabs.io/v1/speech-to-text"
	ElevenSubscriptionURL = "https://api.elevenlabs.io/v1/user/subscription"
)

// ElevenClient talks to ElevenLabs Scribe through a pool of accounts.
type ElevenClient struct {
	// Model is the STT model id ("scribe_v1", "scribe_v2", ...).
	Model string
	// URL is the transcribe endpoint; SubURL the subscription endpoint the
	// probe uses. Both overridable for tests.
	URL    string
	SubURL string
	HTTP   *http.Client
	// Pool is the account scheduler. Nil or empty means "no ElevenLabs" and
	// every call returns ErrNoKeys.
	Pool *KeyPool
}

// NewEleven builds the client over the given accounts.
func NewEleven(keys []string, model, endpoint, poolPath string) *ElevenClient {
	if endpoint == "" {
		endpoint = ElevenTranscribeURL
	}
	return &ElevenClient{
		Model:  model,
		URL:    endpoint,
		SubURL: ElevenSubscriptionURL,
		HTTP:   &http.Client{Timeout: 180 * time.Second},
		Pool:   NewKeyPool(poolPath, keys),
	}
}

// elevenResponse is the Scribe reply. Words carry chunk-relative seconds and
// a type: "word" is speech, "spacing" is the space between words (absent for
// languages that do not use spaces), "audio_event" is laughter, music and so
// on — everything except "word" is dropped, the same way Groq's confidence
// filter keeps only believed speech.
type elevenResponse struct {
	LanguageCode        string       `json:"language_code"`
	LanguageProbability float64      `json:"language_probability"`
	Text                string       `json:"text"`
	Words               []elevenWord `json:"words"`
	AudioDurationSecs   float64      `json:"audio_duration_secs"`
}

type elevenWord struct {
	Text  string  `json:"text"`
	Type  string  `json:"type"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// TranscribeChunk uploads one chunk and returns its segments with times
// shifted into the original video's timeline — the same contract as the Groq
// client's, and the prompt parameter exists for that symmetry even though
// Scribe has no Whisper-style prompt (its equivalent, keyterms, is a paid
// add-on and deliberately unused).
func (c *ElevenClient) TranscribeChunkResult(
	ctx context.Context,
	chunkPath string,
	offsetSecs float64,
	language string,
	_ string,
) (ChunkTranscript, error) {
	if c.Pool == nil || c.Pool.Empty() {
		return ChunkTranscript{}, ErrNoKeys
	}

	// Try a handful of accounts before giving the chunk to the Groq fallback.
	// Bounded, so a pool full of dead keys cannot turn one chunk into an
	// hour of retries; the pool's own cooldowns make the next chunk cheaper.
	attempts := c.Pool.UsableCount()
	if attempts > 3 {
		attempts = 3
	}
	if attempts < 1 {
		attempts = 1
	}

	var lastErr error
	for i := 0; i < attempts; i++ {
		key, err := c.Pool.Pick()
		if err != nil {
			if lastErr != nil {
				return ChunkTranscript{}, lastErr
			}
			return ChunkTranscript{}, err
		}

		ct, err := c.transcribeWith(ctx, key, chunkPath, offsetSecs, language)
		if err == nil {
			c.Pool.Report(key, nil, 0)
			return ct, nil
		}
		c.Pool.Report(key, err, retryAfterOf(err))
		lastErr = err

		// A KEY-level failure is worth another account. A chunk-level one
		// (422 validation, 5xx from a broken upload) would fail identically
		// on every key, so stop here.
		if !keyLevelFailure(err) {
			return ChunkTranscript{}, err
		}
	}
	return ChunkTranscript{}, lastErr
}

// transcribeWith runs one attempt against one account.
func (c *ElevenClient) transcribeWith(
	ctx context.Context,
	key *poolKey,
	chunkPath string,
	offsetSecs float64,
	language string,
) (ChunkTranscript, error) {
	f, err := os.Open(chunkPath)
	if err != nil {
		return ChunkTranscript{}, fmt.Errorf("open chunk %s: %w", filepath.Base(chunkPath), err)
	}
	defer f.Close()

	// Same io.Pipe streaming pattern as the Groq client: the chunk is read
	// into the multipart body in fixed-size blocks and never held whole.
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)

	go func() {
		var writeErr error
		defer func() {
			_ = mw.Close()
			pw.CloseWithError(writeErr)
		}()

		if writeErr = mw.WriteField("model_id", c.Model); writeErr != nil {
			return
		}
		// Word granularity is what lets a split cut the text as well as the
		// timeline; segmentsFromWords then rebuilds transcript lines.
		if writeErr = mw.WriteField("timestamps_granularity", "word"); writeErr != nil {
			return
		}
		// Audio events are noise tags, not transcript; ask for none rather
		// than filter them out of the reply.
		if writeErr = mw.WriteField("tag_audio_events", "false"); writeErr != nil {
			return
		}
		if language != "" {
			// Scribe takes ISO-639-1 (or -3); the pinned language already is
			// an ISO-639-1 code by the time it reaches here.
			if writeErr = mw.WriteField("language_code", language); writeErr != nil {
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

	ctx = MergeCallMeta(ctx, CallMeta{Model: c.Model, KeyID: key.Hash})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, pr)
	if err != nil {
		return ChunkTranscript{}, fmt.Errorf("build elevenlabs request: %w", err)
	}
	req.Header.Set("xi-api-key", key.Key)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return ChunkTranscript{}, fmt.Errorf("elevenlabs request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return ChunkTranscript{}, fmt.Errorf("read elevenlabs response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return ChunkTranscript{}, &APIError{Status: resp.StatusCode, Body: string(body), Service: "elevenlabs"}
	}

	var parsed elevenResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ChunkTranscript{}, fmt.Errorf("decode elevenlabs response: %w", err)
	}

	// Keep the words that are speech, drop spacing and audio events, then
	// reuse the Groq word→lines grouping: the pause/sentence/length rules are
	// engine-agnostic and both editors downstream expect segments.
	words := make([]groqWord, 0, len(parsed.Words))
	for _, w := range parsed.Words {
		if w.Type != "word" {
			continue
		}
		words = append(words, groqWord{Word: w.Text, Start: w.Start, End: w.End})
	}
	segments := segmentsFromWords(words, offsetSecs)

	return ChunkTranscript{
		Segments: segments,
		Language: strings.TrimSpace(parsed.LanguageCode),
	}, nil
}

// keyLevelFailure reports whether a different account could succeed where
// this one failed. 401/403 (bad key), 429 (rate limit) and 402 (quota spent)
// are account properties; everything else belongs to the chunk or the wire.
func keyLevelFailure(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return false // transport errors: one retry is the client's bounded try loop
	}
	switch apiErr.Status {
	case http.StatusUnauthorized, http.StatusForbidden,
		http.StatusTooManyRequests, http.StatusPaymentRequired:
		return true
	default:
		return false
	}
}

// retryAfterOf extracts a Retry-After hint the provider may have attached to
// a 429. A parse failure is no failure: zero means "use the curve".
func retryAfterOf(err error) time.Duration {
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		return 0
	}
	if apiErr.Status != http.StatusTooManyRequests {
		return 0
	}
	return parseRetryAfter(apiErr.Body)
}

// parseRetryAfter reads a Retry-After delay out of an error body, which the
// pool stores as JSON. ElevenLabs wraps details in {"detail": {...}}; both a
// bare number and a structured message are accepted.
func parseRetryAfter(body string) time.Duration {
	var probe struct {
		Detail struct {
			Status       string  `json:"status"`
			Message      string  `json:"message"`
			RetryAfter   float64 `json:"retry_after"`
			RetryAfterMs float64 `json:"retry_after_ms"`
		} `json:"detail"`
	}
	if json.Unmarshal([]byte(body), &probe) != nil {
		return 0
	}
	if probe.Detail.RetryAfterMs > 0 {
		return time.Duration(probe.Detail.RetryAfterMs) * time.Millisecond
	}
	if probe.Detail.RetryAfter > 0 {
		return time.Duration(probe.Detail.RetryAfter) * time.Second
	}
	return 0
}

// Status classifiers for the pool. They unwrap the APIError the client wraps
// its failures in, so the pool never imports net/http itself.

func isAuthStatus(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) &&
		(apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden)
}

func isRateStatus(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusTooManyRequests
}

func isQuotaStatus(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusPaymentRequired
}

// ── probe ───────────────────────────────────────────────────────────────

// ElevenProbeResult is ProbeResult plus what the subscription endpoint gives
// for free: the account's tier and where its quota stands. The UI shows
// "62% used this month" instead of a blind yes/no, and the pool remembers it.
type ElevenProbeResult struct {
	ProbeResult
	Tier       string `json:"tier,omitempty"`
	QuotaUsed  int64  `json:"quota_used,omitempty"`
	QuotaLimit int64  `json:"quota_limit,omitempty"`
	ResetUnix  int64  `json:"reset_unix,omitempty"`
}

// subscription is the slice of /v1/user/subscription the probe reads.
type subscription struct {
	Tier           string `json:"tier"`
	CharacterCount int64  `json:"character_count"`
	CharacterLimit int64  `json:"character_limit"`
	NextResetUnix  int64  `json:"next_character_count_reset_unix"`
}

// Probe reports whether an ElevenLabs key is live by reading the account's
// subscription — a GET that costs no transcription quota and answers 401 for
// a rejected key. An empty key asks the pool for one and probes that, which
// is how the UI re-verifies what the daemon was started with.
func (c *ElevenClient) Probe(ctx context.Context, key string) ElevenProbeResult {
	subURL := c.SubURL
	if subURL == "" {
		subURL = ElevenSubscriptionURL
	}

	if key == "" && c.Pool != nil && !c.Pool.Empty() {
		picked, err := c.Pool.Pick()
		if err == nil {
			key = picked.Key
			defer c.Pool.Report(picked, nil, 0)
		}
	}
	if key == "" {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: "no ElevenLabs key yet — paste one above",
		}}
	}

	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, subURL, nil)
	if err != nil {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: "could not build the test request: " + err.Error(),
		}}
	}
	req.Header.Set("xi-api-key", key)

	res, err := c.HTTP.Do(req)
	if err != nil {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: "could not reach api.elevenlabs.io: " + err.Error(),
		}}
	}
	defer func() { _ = res.Body.Close() }()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxProbeBody))
	if err != nil {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: "the test response was cut short: " + err.Error(),
		}}
	}
	if res.StatusCode != http.StatusOK {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: httpStatusError("ElevenLabs", res.StatusCode, body).Error(),
		}}
	}

	var sub subscription
	if err := json.Unmarshal(body, &sub); err != nil {
		return ElevenProbeResult{ProbeResult: ProbeResult{
			OK: false, Detail: "ElevenLabs sent an unreadable answer: " + err.Error(),
		}}
	}
	return ElevenProbeResult{
		ProbeResult: ProbeResult{
			OK:     true,
			Detail: "key works — " + strings.TrimSpace(sub.Tier) + " account",
		},
		Tier:       sub.Tier,
		QuotaUsed:  sub.CharacterCount,
		QuotaLimit: sub.CharacterLimit,
		ResetUnix:  sub.NextResetUnix,
	}
}
