// Package cloud — keypool_test.go: the scheduler's contract.
//
// The pool is the piece ten paid accounts depend on, so its tests pin the
// behaviour that keeps quota spend even and failures recoverable: rotation
// balance, the LRU tie-break, per-status cooldowns, disable-on-401, dedupe,
// and the disk roundtrip that survives a daemon restart. The clock is fake —
// p.now is a field precisely so these tests never sleep.
package cloud

import (
	"errors"
	"os"
	"testing"
	"time"
)

// fakeClockPool builds a memory-only pool over a frozen, manually advanced
// clock. Tests move `now` forward instead of sleeping.
func fakeClockPool(keys ...string) (*KeyPool, *time.Time) {
	t0 := time.Unix(1_700_000_000, 0)
	p := NewKeyPool("", keys)
	now := t0
	p.now = func() time.Time { return now }
	return p, &now
}

func pick(t *testing.T, p *KeyPool) *poolKey {
	t.Helper()
	k, err := p.Pick()
	if err != nil {
		t.Fatalf("pick: %v", err)
	}
	return k
}

// TestPoolRotatesAccountsEvenly is the fairness guarantee: with three fresh
// accounts, the first three picks must be three different accounts. An
// uneven start would burn one account's monthly quota before the others'
// while the whole point of the pool is maximum combined runtime.
func TestPoolRotatesAccountsEvenly(t *testing.T) {
	p, _ := fakeClockPool("A", "B", "C")

	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		k := pick(t, p)
		if seen[k.Key] {
			t.Fatalf("pick %d reused key %q before covering all accounts", i, k.Key)
		}
		seen[k.Key] = true
	}
}

// TestPoolLRUTieBreakAlternates pins the third ordering rule: two accounts
// with equal uses alternate, because LastUsed breaks the tie. k1, k2, k1 —
// never the same key twice in a row when its peer is idle.
func TestPoolLRUTieBreakAlternates(t *testing.T) {
	p, now := fakeClockPool("A", "B")

	first := pick(t, p)
	p.Report(first, nil, 0)

	*now = now.Add(time.Second)
	second := pick(t, p)
	if second.Key == first.Key {
		t.Fatalf("second pick reused %q; the idle account must go first", first.Key)
	}
	p.Report(second, nil, 0)

	*now = now.Add(time.Second)
	third := pick(t, p)
	if third.Key != first.Key {
		t.Fatalf("third pick = %q, want %q (the least-recently-used of the equals)", third.Key, first.Key)
	}
}

// TestEscalatingCooldownCurve pins the backoff numbers: 30s doubling per
// repeat failure, capped at an hour. A code change here silently changes how
// long a rate-limited account benches, so the numbers are written down.
func TestEscalatingCooldownCurve(t *testing.T) {
	cases := []struct {
		fails int
		want  time.Duration
	}{
		{1, 30 * time.Second},
		{2, 1 * time.Minute},
		{3, 2 * time.Minute},
		{4, 4 * time.Minute},
		{5, 8 * time.Minute},
		{7, 32 * time.Minute},
		{8, time.Hour}, // 64m would exceed the cap
		{20, time.Hour},
	}
	for _, c := range cases {
		if got := escalating(c.fails); got != c.want {
			t.Errorf("escalating(%d) = %s, want %s", c.fails, got, c.want)
		}
	}
}

// TestPool429CooldownsTheAccount: a rate-limited account must leave the
// rotation immediately, with the provider's Retry-After honoured before the
// curve.
func TestPool429CooldownsTheAccount(t *testing.T) {
	p, _ := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 429, Service: "elevenlabs"}, 0)

	if _, err := p.Pick(); !errors.Is(err, ErrPoolExhausted) {
		t.Fatalf("pick after 429 = %v, want ErrPoolExhausted", err)
	}
	st := p.Snapshot()[0]
	if st.State != "cooldown" {
		t.Errorf("state = %q, want cooldown", st.State)
	}
	if st.Cooldown < 30 || st.Cooldown > 31 {
		t.Errorf("cooldown = %ds, want the ~30s first-step curve", st.Cooldown)
	}
}

func TestPool429HonoursRetryAfter(t *testing.T) {
	p, _ := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 429, Service: "elevenlabs"}, 90*time.Second)

	if got := p.Snapshot()[0].Cooldown; got != 91 { // int(90)+1, the ceil bump
		t.Errorf("cooldown = %ds, want the provider's 90s (+1) verbatim", got)
	}
}

// TestPool401DisablesKeyUntilReadded: time cannot fix a revoked credential,
// so a 401 must bench the account forever (until the user swaps the key),
// never serve again, and show as disabled in the UI.
func TestPool401DisablesKeyUntilReadded(t *testing.T) {
	p, now := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 401, Service: "elevenlabs"}, 0)

	*now = now.Add(48 * time.Hour) // even a day later it must stay dead
	if got := p.UsableCount(); got != 0 {
		t.Fatalf("usable = %d after a 401, want 0", got)
	}
	_, err := p.Pick()
	if !errors.Is(err, ErrPoolExhausted) {
		t.Fatalf("pick after 401 = %v, want ErrPoolExhausted", err)
	}
	if st := p.Snapshot()[0]; st.State != "disabled" {
		t.Errorf("state = %q, want disabled", st.State)
	}
}

func TestPool402QuotaCooldownIsHours(t *testing.T) {
	p, _ := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 402, Service: "elevenlabs"}, 0)

	st := p.Snapshot()[0]
	if st.State != "cooldown" || st.Cooldown < 4*60*60-1 {
		t.Errorf("state/cooldown = %q/%ds, want a ~4h quota cooldown", st.State, st.Cooldown)
	}
}

func TestPool5xxCooldownIsShort(t *testing.T) {
	p, _ := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 500, Service: "elevenlabs"}, 0)

	// A provider hiccup is not the account's fault: 15s, next account now.
	if got := p.Snapshot()[0].Cooldown; got < 15 || got > 16 {
		t.Errorf("cooldown = %ds, want the 15s transient window", got)
	}
}

// TestPoolSuccessResetsFailureState: one 429 followed by a win must leave the
// account fully clean — a stale error string or counter would confuse the UI.
func TestPoolSuccessResetsFailureState(t *testing.T) {
	p, now := fakeClockPool("A")

	k := pick(t, p)
	p.Report(k, &APIError{Status: 429, Service: "elevenlabs"}, 0)

	*now = now.Add(time.Minute) // past the cooldown
	k2 := pick(t, p)
	p.Report(k2, nil, 0)

	st := p.Snapshot()[0]
	if st.State != "ready" || st.LastError != "" {
		t.Errorf("state/err = %q/%q after a success, want ready/empty", st.State, st.LastError)
	}
}

func TestPoolAddDedupesByKey(t *testing.T) {
	p, _ := fakeClockPool()

	if _, isNew := p.Add("same-key"); !isNew {
		t.Error("first add must be new")
	}
	if _, isNew := p.Add("same-key"); isNew {
		t.Error("second add of an identical key must not duplicate it")
	}
	if got := len(p.Snapshot()); got != 1 {
		t.Fatalf("pool holds %d accounts, want 1", got)
	}
}

func TestPoolRemoveByHash(t *testing.T) {
	p, _ := fakeClockPool("A")
	hash := keyHash("A")

	if !p.Remove(hash) {
		t.Error("remove of an existing hash must report true")
	}
	if p.Remove(hash) {
		t.Error("remove of an absent hash must report false")
	}
	if !p.Empty() {
		t.Error("pool should be empty after removing its only key")
	}
}

func TestPoolEmptyReturnsErrNoKeys(t *testing.T) {
	p, _ := fakeClockPool()

	if _, err := p.Pick(); !errors.Is(err, ErrNoKeys) {
		t.Fatalf("pick on an empty pool = %v, want ErrNoKeys", err)
	}
}

// TestPoolPersistenceRoundtrip pins the restart contract: a cooldown and its
// usage count recorded before the restart must reappear in a rebuilt pool.
// Forgetting a cooldown is not cosmetic — the account would come back and
// burn another 429 before the daemon learned it was rate-limited again.
func TestPoolPersistenceRoundtrip(t *testing.T) {
	path := t.TempDir() + "/eleven.pool.json"

	p1 := NewKeyPool(path, []string{"A", "B"})
	k := pick(t, p1)
	p1.Report(k, &APIError{Status: 429, Service: "elevenlabs"}, 0)
	worked := k.Key

	p2 := NewKeyPool(path, []string{"A", "B"}) // the "restart"
	var cooled KeyStatus
	for _, st := range p2.Snapshot() {
		if st.State == "cooldown" {
			cooled = st
			break
		}
	}
	if cooled.ID == "" {
		t.Fatal("rebuilt pool forgot the cooldown")
	}
	if cooled.ID != keyHash(worked) {
		t.Errorf("cooled account = %s, want %s", cooled.ID, keyHash(worked))
	}
}

// TestPoolPersistenceDropsRemovedKeys: the config decides WHICH accounts
// exist. A key deleted from the overlay must not haunt the pool file forever.
func TestPoolPersistenceDropsRemovedKeys(t *testing.T) {
	path := t.TempDir() + "/eleven.pool.json"

	p1 := NewKeyPool(path, []string{"A", "B"})
	p1.Add("C")
	p1.Remove(keyHash("C"))

	p2 := NewKeyPool(path, []string{"A", "B"})
	if got := len(p2.Snapshot()); got != 2 {
		t.Fatalf("pool holds %d accounts, want exactly A and B", got)
	}
}

func TestPoolPersistenceIgnoresUnreadableFile(t *testing.T) {
	path := t.TempDir() + "/eleven.pool.json"
	if err := os.WriteFile(path, []byte("not json at all"), 0o600); err != nil {
		t.Fatal(err)
	}

	// A corrupt stats file must cost nothing: a fresh, working pool is the
	// correct recovery, not a crash at startup.
	p := NewKeyPool(path, []string{"A"})
	if k := pick(t, p); k.Key != "A" {
		t.Fatalf("pick = %q after a corrupt pool file", k.Key)
	}
}
