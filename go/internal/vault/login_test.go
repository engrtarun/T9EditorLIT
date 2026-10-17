package vault

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The rule that makes QR login the only kind this daemon does.
//
// Telegram sends a login code the moment a code-based flow starts. On a
// headless machine that code can never be typed back, so the run can only fail
// — after spending a real code on the user's phone. Nothing in this transport
// may ask for a phone number or a code, and this test is what keeps that true
// when someone "helpfully" adds a fallback.
func TestNoCodeBasedLoginPathExists(t *testing.T) {
	// Read the real struct: a fallback added later shows up here without
	// anyone having to remember to update a list.
	fields := reflect.TypeOf(TelegramOptions{})
	for i := 0; i < fields.NumField(); i++ {
		name := strings.ToLower(fields.Field(i).Name)
		if strings.Contains(name, "phone") || strings.Contains(name, "code") {
			t.Errorf("TelegramOptions has a %q field: QR login needs neither a "+
				"phone number nor a login code", fields.Field(i).Name)
		}
	}

	// With no credentials a login attempt must fail locally rather than opening
	// a connection and asking Telegram for anything.
	transport := New(TelegramOptions{SessionDir: t.TempDir()})
	if _, err := transport.BeginLogin(context.Background()); err == nil {
		t.Error("BeginLogin succeeded without credentials")
	}
}

// The UI polls this, so the JSON shape is part of the contract with the desktop
// app. snake_case matches every other model in the daemon.
func TestLoginChallengeJSONShape(t *testing.T) {
	challenge := LoginChallenge{
		ID:          "abc123",
		URL:         "tg://login?token=AAAA",
		ExpiresUnix: 1_700_000_000,
		Phase:       LoginWaiting,
		Rotations:   2,
	}

	raw, err := json.Marshal(challenge)
	if err != nil {
		t.Fatal(err)
	}

	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"id", "url", "expires_unix", "phase", "rotations"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("missing %q in %s", key, raw)
		}
	}
	if fields["phase"] != string(LoginWaiting) {
		t.Errorf("phase = %v, want %q", fields["phase"], LoginWaiting)
	}
}

// The token rotates roughly every 30 seconds, and asking for a new one kills
// the old. The UI therefore has to notice the change rather than sit on a dead
// code, which is what Rotations is for.
func TestLoginStateCountsRotations(t *testing.T) {
	state := &loginState{id: "x"}

	first := "tg://login?token=AAAA"
	state.setURL(first, time.Unix(100, 0))
	if got := state.snapshot().URL; got != first {
		t.Errorf("URL = %q, want %q", got, first)
	}
	if got := state.snapshot().Rotations; got != 1 {
		t.Errorf("Rotations = %d after the first token, want 1", got)
	}
	if got := state.snapshot().Phase; got != LoginWaiting {
		t.Errorf("Phase = %q, want waiting as soon as a token exists", got)
	}

	// The same token again is not a rotation.
	state.setURL(first, time.Unix(100, 0))
	if got := state.snapshot().Rotations; got != 1 {
		t.Errorf("Rotations = %d, want 1 (the same token is not a rotation)", got)
	}

	state.setURL("tg://login?token=BBBB", time.Unix(130, 0))
	if got := state.snapshot().Rotations; got != 2 {
		t.Errorf("Rotations = %d, want 2", got)
	}
	if got := state.snapshot().URL; got != "tg://login?token=BBBB" {
		t.Errorf("URL = %q, want the new token", got)
	}
}

func TestLoginStatePhaseAndDetail(t *testing.T) {
	state := &loginState{id: "x"}
	state.setPhase(LoginPasswordNeeded, ErrPasswordRequired.Error())

	got := state.snapshot()
	if got.Phase != LoginPasswordNeeded {
		t.Errorf("Phase = %q", got.Phase)
	}
	if !strings.Contains(got.Detail, "Two-Step") {
		t.Errorf("Detail = %q, want it to name the problem", got.Detail)
	}
}

// A poller that arrives after the attempt finished must get a terminal state,
// not a 404 it cannot interpret.
func TestPollLoginOnAnUnknownAttemptIsExpired(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})

	got, err := transport.PollLogin(context.Background(), "never-existed")
	if err != nil {
		t.Fatalf("PollLogin: %v", err)
	}
	if got.Phase != LoginExpired {
		t.Errorf("Phase = %q, want expired", got.Phase)
	}
	if got.ID != "never-existed" {
		t.Errorf("ID = %q, want the id it was asked about", got.ID)
	}
}

// Cancelling anything is always safe: no code was requested, so there is nothing
// on Telegram's side to clean up. That includes cancelling an attempt that does
// not exist.
func TestCancelLoginIsSafeOnAnything(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})
	transport.CancelLogin("never-existed")
	transport.CancelLogin("")
}

func TestNewLoginIDIsUnique(t *testing.T) {
	seen := make(map[string]bool, 64)
	for i := 0; i < 64; i++ {
		id := newLoginID()
		if id == "" {
			t.Fatal("empty login id")
		}
		if seen[id] {
			t.Fatalf("duplicate login id %q after %d draws", id, i)
		}
		seen[id] = true
	}
}
