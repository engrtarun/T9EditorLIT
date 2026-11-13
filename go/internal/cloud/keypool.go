// Package cloud — keypool.go: many accounts, one transcriber.
//
// ElevenLabs free accounts carry a monthly quota, and the user feeds the pool
// every account they own (ten at the time of writing). One exhausted or
// rate-limited key must therefore never stall a transcription: the pool picks
// the best available account for every request and pushes a failing account
// aside with an escalating cooldown until its window clears.
//
// The scheduler is a min-heap. The ordering puts a key ahead of another when
//
//  1. it becomes usable sooner (cooldown expiry; a disabled key sorts last),
//  2. it has been used less often (so ten accounts share the load evenly and
//     the pool's total quota lasts the maximum possible time),
//  3. it was used longer ago (LRU, so identical keys still alternate).
//
// Pick() reads the heap root: the earliest-available key is exactly the root,
// so "is anything usable?" is O(1) and "which one?" is O(log n). Every
// mutation re-fixes the root's position, which is the whole cost. With pools
// of ten to a few dozen keys this is far below measurable, and the shape
// stays honest if a user ever pastes a hundred.
//
// Usage counters, cooldowns and key health persist to a small JSON file
// (config.PoolPath) beside the keys overlay, so a daemon restart does not
// resurrect a cooling key or forget which account did the work. The file is
// tiny — one record per key — and stays on disk, in line with the project's
// "state on disk, not in the heap" rule.
package cloud

import (
	"container/heap"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Pool errors the transcribe path reacts to. They are the pool's way of
// saying "the ElevenLabs side is out for now" — runTranscribe falls back to
// Groq on either one.
var (
	// ErrNoKeys means the pool has no accounts at all.
	ErrNoKeys = errors.New("no ElevenLabs keys configured")
	// ErrPoolExhausted means every account is cooling down or disabled.
	ErrPoolExhausted = errors.New("every ElevenLabs key is cooling down or disabled")
)

// Cooldown policy. The escalation is deliberately gentler than the queue's
// job retry: a 429 from one account should not retire the whole job, just
// this account for a bit.
const (
	baseCooldown  = 30 * time.Second // first failure on an account
	maxCooldown   = time.Hour        // escalation ceiling for 429s
	transientCool = 15 * time.Second // 5xx / network: next account, same job
	quotaCool     = 4 * time.Hour    // 402: the month's minutes are gone
	cooldownStep  = 2.0              // exponential backoff factor
)

// farFuture is the "disabled" timestamp. Year 29k keeps the heap honest and
// the arithmetic harmless: a disabled key is only ever picked after every
// working key, which in practice means never.
var farFuture = time.Unix(1<<40, 0).UTC()

// poolKey is one ElevenLabs account as the pool sees it.
//
// Key is the credential itself; it is never serialised (json:"-") so the pool
// file and every API response are key-free. Hash is the key's stable public
// identity: the UI removes a key by hash and never learns the secret.
type poolKey struct {
	Key  string `json:"-"`
	Hash string `json:"hash"`

	Uses     int       `json:"uses"`
	Fails    int       `json:"fails"`
	Disabled bool      `json:"disabled,omitempty"`
	Cooled   time.Time `json:"cooldown_until,omitempty"`
	LastUsed time.Time `json:"last_used,omitempty"`
	LastErr  string    `json:"last_error,omitempty"`

	// Quota snapshot from the last probe, for the UI's per-account display.
	Tier       string `json:"tier,omitempty"`
	QuotaUsed  int64  `json:"quota_used,omitempty"`
	QuotaLimit int64  `json:"quota_limit,omitempty"`

	idx int // position in the heap; maintained by heap.Interface
}

// availableAt is when the key can serve again. A disabled key waits forever —
// the provider already said the credential itself is wrong, and time will not
// fix that. Cooldowns share one ordering with it, which is what lets a single
// heap answer "who is next?".
func (k *poolKey) availableAt() time.Time {
	if k.Disabled {
		return farFuture
	}
	return k.Cooled
}

// KeyStatus is what the UI may see: enough to manage accounts, never the key.
type KeyStatus struct {
	ID         string `json:"id"`
	Masked     string `json:"masked"`
	State      string `json:"state"` // ready | cooldown | disabled
	Uses       int    `json:"uses"`
	Cooldown   int    `json:"cooldown_secs,omitempty"` // seconds until usable again
	LastError  string `json:"last_error,omitempty"`
	Tier       string `json:"tier,omitempty"`
	QuotaUsed  int64  `json:"quota_used,omitempty"`
	QuotaLimit int64  `json:"quota_limit,omitempty"`
}

// KeyPool schedules the accounts. The heap slice IS the key set; there is no
// second list that could drift out of sync with it.
type KeyPool struct {
	mu   sync.Mutex
	h    keyHeap
	path string // persistence; "" is memory-only (tests)
	now  func() time.Time
}

// NewKeyPool builds a pool from the configured keys and restores whatever the
// stats file remembers about them. Keys present in the config but not in the
// file start fresh; keys in the file but no longer configured are dropped —
// the config (overlay + .env) is the source of truth for WHICH accounts
// exist, the file only remembers how they have been doing.
func NewKeyPool(path string, keys []string) *KeyPool {
	p := &KeyPool{path: path, now: time.Now}
	for _, k := range keys {
		p.h = append(p.h, &poolKey{Key: k, Hash: keyHash(k)})
	}
	p.restore()
	heap.Init(&p.h)
	return p
}

// Empty reports whether the pool has no accounts at all.
func (p *KeyPool) Empty() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.h) == 0
}

// UsableCount is how many accounts are neither disabled nor cooling right now.
// The client uses it to bound per-chunk key rotation attempts.
func (p *KeyPool) UsableCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	n := 0
	for _, k := range p.h {
		if !k.Disabled && !k.Cooled.After(now) {
			n++
		}
	}
	return n
}

// Pick returns the next account to use and counts the use.
//
// The heap root is the earliest-available key: if even the root is not
// usable, nothing is, and the error says when the first account returns.
// The use counter is deliberately not persisted here — a crash losing the
// last increment is meaningless, and one disk write per chunk saved.
func (p *KeyPool) Pick() (*poolKey, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.h) == 0 {
		return nil, ErrNoKeys
	}
	root := p.h[0]
	now := p.now()
	if root.Disabled {
		return nil, fmt.Errorf("%w (every key was rejected by the provider)", ErrPoolExhausted)
	}
	if root.Cooled.After(now) {
		return nil, fmt.Errorf("%w (first key back in %s)", ErrPoolExhausted, root.Cooled.Sub(now).Round(time.Second))
	}
	root.Uses++
	root.LastUsed = now
	heap.Fix(&p.h, root.idx)
	return root, nil
}

// Report records one request's outcome and re-sorts the account.
//
// retryAfter carries a provider-provided wait (the Retry-After header) when
// there is one; the escalation uses it verbatim before falling back to the
// exponential curve. Outcomes are persisted, so cooldowns survive a restart —
// the whole point of a monthly quota is that forgetting it is expensive.
func (p *KeyPool) Report(k *poolKey, err error, retryAfter time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()

	switch {
	case err == nil:
		k.Fails = 0
		k.Cooled = time.Time{}
		k.LastErr = ""
	case isAuthStatus(err):
		// 401/403: the credential is wrong or revoked. No cooldown helps;
		// only the user re-adding a good key does. Disabled keys stay in the
		// pool so the UI can show them, but they can never be picked.
		k.Disabled = true
		k.LastErr = err.Error()
		k.Fails = 0
		k.Cooled = time.Time{}
	case isRateStatus(err):
		k.Fails++
		wait := retryAfter
		if wait <= 0 {
			wait = escalating(k.Fails)
		}
		k.Cooled = now.Add(wait)
		k.LastErr = err.Error()
	case isQuotaStatus(err):
		// 402: the account's monthly minutes are spent. Hours, not seconds —
		// but not forever, because a fresh billing month (or an upgraded
		// plan) revives the account without daemon action.
		k.Fails = 0
		k.Cooled = now.Add(quotaCool)
		k.LastErr = err.Error()
	default:
		k.Fails++
		k.Cooled = now.Add(transientCool)
		k.LastErr = err.Error()
	}

	heap.Fix(&p.h, k.idx)
	p.persist()
}

// SetQuota records what a probe learned about the account, so the UI can show
// "62% of this month used" instead of a blind yes/no.
func (p *KeyPool) SetQuota(k *poolKey, tier string, used, limit int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	k.Tier = tier
	k.QuotaUsed = used
	k.QuotaLimit = limit
	p.persist()
}

// SetEnabled manually disables or re-enables one account. A re-enabled account
// has its cooldown and failure count cleared, because the user is asserting
// "try this again"; a disabled account waits forever, like an auth failure.
// It reports whether the account existed.
func (p *KeyPool) SetEnabled(hash string, on bool) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, k := range p.h {
		if k.Hash != hash {
			continue
		}
		k.Disabled = !on
		if on {
			k.Cooled = time.Time{}
			k.Fails = 0
			k.LastErr = ""
		}
		heap.Fix(&p.h, i)
		p.persist()
		return true
	}
	return false
}

// Add inserts one key, deduplicating by hash. It returns the pool entry —
// the caller records quota against it right after a probe — and whether the
// key was new. "Already here" is not an error: the entry comes back so the
// caller can still refresh what it learned about the account.
func (p *KeyPool) Add(key string) (*poolKey, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	hash := keyHash(key)
	for _, k := range p.h {
		if k.Hash == hash {
			return k, false
		}
	}
	k := &poolKey{Key: key, Hash: hash}
	heap.Push(&p.h, k)
	p.persist()
	return k, true
}

// Remove drops one key by its public hash. It reports whether it existed.
func (p *KeyPool) Remove(hash string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, k := range p.h {
		if k.Hash == hash {
			heap.Remove(&p.h, i)
			p.persist()
			return true
		}
	}
	return false
}

// Clear drops every account.
func (p *KeyPool) Clear() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.h = keyHeap{}
	p.persist()
}

// Keys returns the full credentials. The ONLY caller is the overlay writer —
// this never crosses an HTTP response.
func (p *KeyPool) Keys() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, 0, len(p.h))
	for _, k := range p.h {
		out = append(out, k.Key)
	}
	return out
}

// Snapshot is the UI-facing view: masked keys, health and quota per account.
func (p *KeyPool) Snapshot() []KeyStatus {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	out := make([]KeyStatus, 0, len(p.h))
	for _, k := range p.h {
		st := KeyStatus{
			ID:         k.Hash,
			Masked:     maskKeyText(k.Key),
			Uses:       k.Uses,
			LastError:  k.LastErr,
			Tier:       k.Tier,
			QuotaUsed:  k.QuotaUsed,
			QuotaLimit: k.QuotaLimit,
		}
		switch {
		case k.Disabled:
			st.State = "disabled"
		case k.Cooled.After(now):
			st.State = "cooldown"
			st.Cooldown = int(k.Cooled.Sub(now).Seconds()) + 1
		default:
			st.State = "ready"
		}
		out = append(out, st)
	}
	return out
}

// escalating is the exponential cooldown curve: 30s, 1m, 2m, 4m … capped at
// an hour. After the cap the account waits like one with a spent quota; the
// next probe or a billing month is the reset path.
func escalating(fails int) time.Duration {
	d := baseCooldown
	for i := 1; i < fails && d < maxCooldown; i++ {
		d = time.Duration(float64(d) * cooldownStep)
	}
	if d > maxCooldown {
		d = maxCooldown
	}
	return d
}

// keyHash is a key's public identity: the first 12 hex chars of its SHA-256.
func keyHash(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:12]
}

// maskKeyText mirrors the API layer's masking rule so the pool file and the
// UI agree on what "recognisable but safe" means.
func maskKeyText(key string) string {
	r := []rune(key)
	switch {
	case len(r) == 0:
		return ""
	case len(r) <= 8:
		return "••••"
	default:
		return string(r[:4]) + "…" + string(r[len(r)-4:])
	}
}

// ── persistence ─────────────────────────────────────────────────────────

// poolRecord is one account's line in the stats file.
type poolRecord struct {
	Hash       string    `json:"hash"`
	Uses       int       `json:"uses"`
	Fails      int       `json:"fails"`
	Disabled   bool      `json:"disabled,omitempty"`
	Cooled     time.Time `json:"cooldown_until,omitempty"`
	LastUsed   time.Time `json:"last_used,omitempty"`
	LastErr    string    `json:"last_error,omitempty"`
	Tier       string    `json:"tier,omitempty"`
	QuotaUsed  int64     `json:"quota_used,omitempty"`
	QuotaLimit int64     `json:"quota_limit,omitempty"`
}

type poolFile struct {
	Keys []poolRecord `json:"keys"`
}

// restore merges the stats file into the freshly built heap. It runs before
// heap.Init, so no heap invariants are involved yet — this is plain field
// copying, matched by hash.
func (p *KeyPool) restore() {
	if p.path == "" {
		return
	}
	raw, err := os.ReadFile(p.path)
	if err != nil {
		return // first run, or the file went away — a fresh pool is correct
	}
	var f poolFile
	if json.Unmarshal(raw, &f) != nil {
		return // unreadable file beats a broken pool: start clean
	}
	byHash := make(map[string]poolRecord, len(f.Keys))
	for _, rec := range f.Keys {
		byHash[rec.Hash] = rec
	}
	for _, k := range p.h {
		rec, ok := byHash[k.Hash]
		if !ok {
			continue
		}
		k.Uses, k.Fails, k.Disabled = rec.Uses, rec.Fails, rec.Disabled
		k.Cooled, k.LastUsed, k.LastErr = rec.Cooled, rec.LastUsed, rec.LastErr
		k.Tier, k.QuotaUsed, k.QuotaLimit = rec.Tier, rec.QuotaUsed, rec.QuotaLimit
	}
}

// persist writes the stats file atomically (temp + rename, 0600) so a crash
// mid-write can never leave a half-recorded pool. A write failure is
// swallowed: the pool keeps working in memory, and the next outcome retries
// the write. Caller holds p.mu.
func (p *KeyPool) persist() {
	if p.path == "" {
		return
	}
	f := poolFile{Keys: make([]poolRecord, 0, len(p.h))}
	for _, k := range p.h {
		f.Keys = append(f.Keys, poolRecord{
			Hash: k.Hash, Uses: k.Uses, Fails: k.Fails, Disabled: k.Disabled,
			Cooled: k.Cooled, LastUsed: k.LastUsed, LastErr: k.LastErr,
			Tier: k.Tier, QuotaUsed: k.QuotaUsed, QuotaLimit: k.QuotaLimit,
		})
	}
	raw, err := json.Marshal(&f)
	if err != nil {
		return
	}
	dir := filepath.Dir(p.path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return
		}
	}
	tmp, err := os.CreateTemp(dir, ".pool-*")
	if err != nil {
		return
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return
	}
	if err := tmp.Close(); err != nil {
		return
	}
	_ = os.Rename(tmpName, p.path)
}

// ── heap ────────────────────────────────────────────────────────────────

// keyHeap orders accounts by (availableAt, uses, lastUsed) — the "least
// recently used among the least-used among the soonest-available" rule from
// the file header. Standard container/heap; the idx field is what makes Fix
// possible after an in-place mutation.
type keyHeap []*poolKey

func (h keyHeap) Len() int { return len(h) }
func (h keyHeap) Less(i, j int) bool {
	a, b := h[i], h[j]
	aa, ba := a.availableAt(), b.availableAt()
	if !aa.Equal(ba) {
		return aa.Before(ba)
	}
	if a.Uses != b.Uses {
		return a.Uses < b.Uses
	}
	return a.LastUsed.Before(b.LastUsed)
}
func (h keyHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].idx, h[j].idx = i, j
}
func (h *keyHeap) Push(x any) {
	k := x.(*poolKey)
	k.idx = len(*h)
	*h = append(*h, k)
}
func (h *keyHeap) Pop() any {
	old := *h
	n := len(old)
	k := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return k
}
