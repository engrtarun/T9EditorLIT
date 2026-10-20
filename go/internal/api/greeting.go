package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Greeting lines: one small piece of energy on the dashboard, in the language
// the user picked.
//
// Why this is not a request per app launch:
//   - a greeting is not worth a network round-trip on every open, and
//   - the API key is shared with transcription, which is the work that
//     actually matters.
//
// So the daemon caches a pair of lines, refreshes at most once every
// greetingTTL, and keeps a hard daily cap. The app always renders a local bank
// line immediately; a fresh pair only replaces it when it arrives in time.
const (
	greetingTTL      = 25 * time.Minute
	greetingRetryTTL = 2 * time.Minute
	greetingDailyCap = 60
	greetingMaxRunes = 64
	greetingTimeout  = 9 * time.Second
)

// greetingPrompt is the whole personality of the feature. Keep it short: a
// long prompt buys nothing for a 60-character answer and costs tokens.
const greetingPrompt = `You greet a 17-22 year old who just opened a video editor to get work done.
Write ONE line per language, like a sharp friend hyping them up: warm, specific, a little cocky.

Rules:
- English: casual, no corporate tone.
- Hinglish: Roman script, real Indian college/creator speak, NOT shuddh Hindi, never cringe.
- Hinglish MUST be written in Latin letters. Never Devanagari.
- HARD LIMIT: 60 characters each. Shorter is better.
- Talk about the work: editing, cuts, clips, uploads, focus, deadlines, late-night grinds.
- No life advice, no "believe in yourself", no "dream big", no fake motivation.
- No surrounding quotes, no hashtags. At most one emoji, none is fine.
- Never mention that you are an AI.

Return ONLY valid JSON: {"en":"...","hi":"..."}`

const greetingUserPrompt = `Give me today's line. Vary the angle: speed, focus, first cut, uploading, deadline mode, late-night grind.`

// greetingBank is the offline floor. It is deliberately written by hand, in
// the same voice as the prompt, so a dead API never shows a blank heading.
var greetingBank = [][2]string{
	{"New tab, new cut. Let's make it clean.", "Naya din, naya cut. Chalo shuru."},
	{"One clip at a time. Go.", "Ek clip, ek cut. Simple."},
	{"The timeline is waiting. Chop something.", "Timeline khaali hai. Kuch kaato."},
	{"First cut hits different. Start.", "Pehla cut alag hi feel deta hai."},
	{"Headphones on, excuses off.", "Headphones lagao, bahane band."},
	{"Make the boring parts disappear.", "Boring part hatao, magic banao."},
	{"Your next upload starts here.", "Aaj ek video upload kar dete hain."},
	{"Small cut now, big flex later.", "Chhota cut aaj, bada flex baad me."},
	{"Rough cut first. Pretty later.", "Rough cut pehle, polish baad me."},
	{"Less scrolling, more trimming.", "Scroll band, trim shuru."},
	{"Deadline mode: on.", "Deadline mode on hai. Chalo."},
	{"Let's ship something today.", "Aaj kuch ship karte hain."},
}

type greetingPair struct {
	EN     string    `json:"en"`
	HI     string    `json:"hi"`
	At     time.Time `json:"at"`
	Source string    `json:"source"`
}

type greetingState struct {
	mu    sync.Mutex
	pair  greetingPair
	day   string
	calls int
}

type greetingResponse struct {
	EN          string `json:"en"`
	HI          string `json:"hi"`
	GeneratedAt string `json:"generatedAt"`
	Source      string `json:"source"`
	Cached      bool   `json:"cached"`
}

// handleGreeting returns one Hinglish and one English line.
//
// The frontend calls it on the dashboard; repeat calls inside greetingTTL are
// served from memory, so opening the app twenty times costs one API call.
func (s *Server) handleGreeting(w http.ResponseWriter, r *http.Request) {
	g := s.greeting
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()
	ttl := greetingTTL
	if g.pair.Source == "bank" {
		ttl = greetingRetryTTL
	}
	if !g.pair.At.IsZero() && now.Sub(g.pair.At) < ttl {
		writeJSON(w, http.StatusOK, greetingPayload(g.pair, true))
		return
	}

	today := now.Format("2006-01-02")
	if g.day != today {
		g.day = today
		g.calls = 0
	}

	if s.deps.Groq == nil || g.calls >= greetingDailyCap {
		writeJSON(w, http.StatusOK, greetingPayload(bankGreeting(now), true))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), greetingTimeout)
	defer cancel()

	g.calls++
	out, err := s.deps.Groq.ChatCreative(ctx, greetingPrompt, greetingUserPrompt)
	if err != nil {
		s.deps.Log.Warn("greeting: groq call failed", "err", err)
		writeJSON(w, http.StatusOK, greetingPayload(bankGreeting(now), true))
		return
	}

	pair, ok := parseGreeting(out, now)
	if !ok {
		s.deps.Log.Warn("greeting: unusable completion", "text", out)
		writeJSON(w, http.StatusOK, greetingPayload(bankGreeting(now), true))
		return
	}

	g.pair = pair
	writeJSON(w, http.StatusOK, greetingPayload(pair, false))
}

func greetingPayload(p greetingPair, cached bool) greetingResponse {
	return greetingResponse{
		EN:          p.EN,
		HI:          p.HI,
		GeneratedAt: p.At.UTC().Format(time.RFC3339),
		Source:      p.Source,
		Cached:      cached,
	}
}

func bankGreeting(now time.Time) greetingPair {
	line := greetingBank[int(now.UnixNano()/int64(time.Second))%len(greetingBank)]
	return greetingPair{EN: line[0], HI: line[1], At: now, Source: "bank"}
}

// parseGreeting accepts the model's JSON, even when it wraps it in a code
// fence or adds a sentence around it — both happen often enough to be normal.
func parseGreeting(raw string, now time.Time) (greetingPair, bool) {
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return greetingPair{}, false
	}

	var decoded struct {
		EN string `json:"en"`
		HI string `json:"hi"`
	}
	if err := json.Unmarshal([]byte(raw[start:end+1]), &decoded); err != nil {
		return greetingPair{}, false
	}

	en := clampGreeting(decoded.EN)
	hi := clampGreeting(decoded.HI)
	if !utf8.ValidString(en) || !utf8.ValidString(hi) || len([]rune(en)) < 8 || len([]rune(hi)) < 8 {
		return greetingPair{}, false
	}
	// Hinglish is Roman script by definition. The model occasionally slips
	// into Devanagari; the user asked for Hinglish, so that answer is not
	// usable and the caller falls back to the hand-written bank.
	if hasDevanagari(hi) {
		return greetingPair{}, false
	}

	return greetingPair{EN: en, HI: hi, At: now, Source: "groq"}, true
}

func hasDevanagari(s string) bool {
	for _, r := range s {
		if r >= 0x0900 && r <= 0x097F {
			return true
		}
	}
	return false
}

// clampGreeting enforces the length limit in the UI's units (runes, not
// bytes) and cuts on a word boundary instead of mid-word.
func clampGreeting(s string) string {
	s = strings.TrimSpace(strings.Trim(s, `"'“”`))
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.Join(strings.Fields(s), " ")

	if utf8.RuneCountInString(s) <= greetingMaxRunes {
		return s
	}

	cut := []rune(s)[:greetingMaxRunes]
	if i := strings.LastIndex(string(cut), " "); i > 16 {
		return strings.TrimSpace(string(cut)[:i])
	}
	return strings.TrimSpace(string(cut))
}
