package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gotd/td/tg"
)

func TestNewAppliesPoolDefaults(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"zero means the measured default", 0, DefaultConnections},
		{"negative means the default too", -4, DefaultConnections},
		{"one connection is allowed", 1, 1},
		{"past the cap is clamped", 50, MaxConnections},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tg := New(TelegramOptions{Connections: tt.in, SessionDir: t.TempDir()})
			if got := tg.Connections(); got != tt.want {
				t.Errorf("Connections = %d, want %d", got, tt.want)
			}
		})
	}
}

// The session file must be inside the session directory and nowhere else: it is
// the auth key, and an auth key in the user's temp folder is one a cleanup tool
// will happily delete.
func TestSessionPathIsInsideTheSessionDir(t *testing.T) {
	dir := t.TempDir()
	transport := New(TelegramOptions{SessionDir: dir})

	want := filepath.Join(dir, "session.json")
	if got := transport.SessionPath(); got != want {
		t.Errorf("SessionPath = %q, want %q", got, want)
	}
}

// Authorised() answers from disk in microseconds, because a health check calls
// it. It must say "no" rather than erroring when there is nothing there yet.
func TestAuthorisedIsFalseWithoutASession(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})
	if transport.Authorised() {
		t.Error("Authorised = true with no session file on disk")
	}
}

// A session file that exists but holds no auth key is not an authorised
// account. This is the state a half-finished QR scan leaves behind.
func TestAuthorisedIgnoresAnEmptySessionFile(t *testing.T) {
	dir := t.TempDir()
	transport := New(TelegramOptions{SessionDir: dir})
	if err := os.WriteFile(transport.SessionPath(), []byte(`{"Version":1,"Data":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	if transport.Authorised() {
		t.Error("Authorised = true for a session with no auth key")
	}
}

// Without credentials the transport must fail before it opens a socket, so a
// daemon started without Telegram never reaches the network.
func TestStatusWithoutCredentialsStaysLocal(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})

	st, err := transport.Status(context.Background())
	if !errors.Is(err, ErrNotConfigured) {
		t.Errorf("error = %v, want ErrNotConfigured", err)
	}
	if st.Configured {
		t.Error("Configured = true with no API credentials")
	}
	if st.Authorised {
		t.Error("Authorised = true with no API credentials")
	}
	if st.PartBytes != DefaultPartBytes {
		t.Errorf("PartBytes = %d, want %d so the UI can preview the split", st.PartBytes, DefaultPartBytes)
	}
}

// The same rule for upload: a missing session is refused, not attempted.
func TestUploadPartsRefusesWithoutAuthorisation(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})

	_, err := transport.UploadParts(context.Background(), "me", "clip.mp4",
		[]Part{{Index: 0, Size: 10}}, []int{0}, nil)
	if !errors.Is(err, ErrNotConfigured) && !errors.Is(err, ErrNotAuthorised) {
		t.Errorf("error = %v, want ErrNotConfigured or ErrNotAuthorised", err)
	}
}

// updateLoginToken is how the phone's tap reaches us. Missing it would mean
// waiting out every token's full lifetime instead of noticing the scan.
func TestHasLoginToken(t *testing.T) {
	yes := []*tg.UpdateLoginToken{{}}

	tests := map[string]struct {
		updates tg.UpdatesClass
		want    bool
	}{
		"short update":     {updates: &tg.UpdateShort{Update: yes[0]}, want: true},
		"updates list":     {updates: &tg.Updates{Updates: []tg.UpdateClass{yes[0]}}, want: true},
		"combined list":    {updates: &tg.UpdatesCombined{Updates: []tg.UpdateClass{yes[0]}}, want: true},
		"unrelated update": {updates: &tg.UpdateShort{Update: &tg.UpdateReadChannelInbox{}}, want: false},
		"empty list":       {updates: &tg.Updates{}, want: false},
		"nil":              {updates: nil, want: false},
	}

	for name, tt := range tests {
		t.Run(name, func(t *testing.T) {
			if got := hasLoginToken(tt.updates); got != tt.want {
				t.Errorf("hasLoginToken = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPartCaption(t *testing.T) {
	single := partCaption("D:/videos/clip.mp4", Part{Index: 0, Size: 120_000_000}, 1)
	if strings.Contains(single, "Part ") {
		t.Errorf("a single part should not be numbered, got %q", single)
	}

	multi := partCaption("D:/videos/clip.mp4", Part{Index: 1, Size: 1_900_000_000}, 3)
	for _, want := range []string{"Part 2/3", "clip.mp4", "1.90 GB"} {
		if !strings.Contains(multi, want) {
			t.Errorf("caption %q is missing %q", multi, want)
		}
	}
}

// t.me links only exist for public channels. A private chat must produce no
// link rather than a broken one.
func TestPartLinkOnlyForPublicChannels(t *testing.T) {
	public := resolvedPeer{
		input:    &tg.InputPeerChannel{ChannelID: 1, AccessHash: 2},
		username: "cloud",
	}
	if got, want := partLink(public, 42), "https://t.me/cloud/42"; got != want {
		t.Errorf("partLink = %q, want %q", got, want)
	}

	private := resolvedPeer{input: &tg.InputPeerChannel{ChannelID: 1, AccessHash: 2}}
	if got := partLink(private, 42); got != "" {
		t.Errorf("partLink = %q, want empty for a private chat", got)
	}

	self := resolvedPeer{input: &tg.InputPeerSelf{}}
	if got := partLink(self, 42); got != "" {
		t.Errorf("partLink = %q, want empty for Saved Messages", got)
	}
}

// The byte counter is what the UI shows. Three concurrent parts each reporting
// their own progress must not triple-count, and a failed attempt's bytes must
// come back off the total.
func TestProgressTrackerCountsBytesOnce(t *testing.T) {
	var last Progress
	tracker := newProgressTracker(func(p Progress) { last = p }, 3000, 3, 3)

	partA := Part{Index: 0, Size: 1000}
	partB := Part{Index: 1, Size: 1000}

	tracker.setPhase(PhaseUploading)
	tracker.partStarted(partA)
	tracker.partStarted(partB)

	// gotd reports cumulative bytes per upload, so the tracker is fed deltas.
	tracker.chunk(0, 400)
	tracker.chunk(1, 250)
	if got, want := last.BytesDone, int64(650); got != want {
		t.Errorf("BytesDone = %d, want %d (three parts must not triple-count)", got, want)
	}

	tracker.chunk(0, 300)
	if got, want := last.BytesDone, int64(950); got != want {
		t.Errorf("BytesDone = %d, want %d", got, want)
	}

	// Storing part A adds the 300 bytes its final RPC never reported, so the
	// total jumps to 1000 plus the 250 of part B still on the wire.
	tracker.partStored(partA)
	if got, want := last.BytesDone, int64(1250); got != want {
		t.Errorf("BytesDone = %d, want %d (a stored part counts whole)", got, want)
	}

	tracker.partFailed(partB)
	if got, want := last.BytesDone, int64(1000); got != want {
		t.Errorf("BytesDone = %d, want %d (a failed part's bytes must come off)", got, want)
	}

	tracker.partStored(partB)
	if got, want := last.PartsDone, 2; got != want {
		t.Errorf("PartsDone = %d, want %d", got, want)
	}
}

// A retried part must not keep the bytes of the attempt that failed, or the
// progress bar runs ahead of what Telegram has actually accepted.
func TestProgressTrackerRetryResetsThePart(t *testing.T) {
	var last Progress
	tracker := newProgressTracker(func(p Progress) { last = p }, 1000, 1, 1)
	part := Part{Index: 0, Size: 1000}

	tracker.partStarted(part)
	tracker.chunk(0, 400)
	tracker.partFailed(part)

	tracker.partStarted(part)
	if last.BytesDone != 0 {
		t.Errorf("BytesDone = %d, want 0 after a retry", last.BytesDone)
	}

	tracker.chunk(0, 1000)
	tracker.partStored(part)
	if last.BytesDone != 1000 {
		t.Errorf("BytesDone = %d, want 1000", last.BytesDone)
	}
}

func TestProgressTrackerIsSafeUnderConcurrency(t *testing.T) {
	tracker := newProgressTracker(nil, 3000, 3, 3)

	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			part := Part{Index: i, Size: 1000}
			tracker.partStarted(part)
			for n := 0; n < 10; n++ {
				tracker.chunk(i, 100)
			}
			tracker.partStored(part)
		}(i)
	}
	wg.Wait()

	tracker.mu.Lock()
	sent, stored := tracker.sent, tracker.stored
	tracker.mu.Unlock()

	if sent != 3000 {
		t.Errorf("sent = %d, want 3000", sent)
	}
	if stored != 3 {
		t.Errorf("stored = %d, want 3", stored)
	}
}

func TestProgressPercent(t *testing.T) {
	if got := (Progress{BytesDone: 500, BytesTotal: 1000}).Percent(); got != 50 {
		t.Errorf("Percent = %v, want 50", got)
	}
	if got := (Progress{}).Percent(); got != 0 {
		t.Errorf("Percent with no total = %v, want 0", got)
	}
}

// Closing a transport that never connected must be a no-op, not a panic. The
// daemon closes it on every shutdown path.
func TestCloseWithoutConnectingIsSafe(t *testing.T) {
	transport := New(TelegramOptions{SessionDir: t.TempDir()})
	transport.Close()
	transport.Close()
}
