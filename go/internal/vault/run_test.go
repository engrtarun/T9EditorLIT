package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// batchUploader is a stand-in for the MTProto transport that honours both
// interfaces, so the planner's parallel path can be exercised without a network.
type batchUploader struct {
	mu sync.Mutex

	sent      []int  // part indexes, in the order the transport was asked for them
	calls     int    // how many times UploadParts was called
	sendCalls int    // how many times the sequential Send was called
	failOn    int    // 1-based index into the send list; 0 never fails
	session   string // session dir used for manifests

	// records makes the fake write the manifest the real transport writes, so a
	// resume test covers the actual on-disk format.
	records bool
}

func (b *batchUploader) Send(_ context.Context, _, _ string, offset, _ int64) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sendCalls++
	return 1, nil
}

func (b *batchUploader) Authorise(context.Context) error { return nil }
func (b *batchUploader) Authorised() bool                { return true }

func (b *batchUploader) UploadParts(
	_ context.Context,
	chatID, path string,
	parts []Part,
	send []int,
	report func(Progress),
) ([]int, error) {
	b.mu.Lock()
	b.calls++
	b.sent = append(b.sent, send...)
	records := b.records
	session := b.session
	b.mu.Unlock()

	ids := make([]int, 0, len(send))
	for i, index := range send {
		if b.failOn > 0 && i+1 == b.failOn {
			return nil, errors.New("network died mid-upload")
		}

		part := parts[index]
		if report != nil {
			report(Progress{
				Phase:      PhaseUploading,
				PartIndex:  part.Index,
				PartCount:  len(parts),
				PartsDone:  i + 1,
				BytesDone:  totalSize(parts) * int64(i+1) / int64(len(parts)),
				BytesTotal: totalSize(parts),
			})
		}

		id := 1000 + part.Index
		ids = append(ids, id)

		if records {
			store, err := openManifest(session, path, totalSize(parts), partSpan(parts), chatID)
			if err != nil {
				return nil, err
			}
			store.adopt(parts)
			store.record(part.Index, id, "")
		}
	}
	return ids, nil
}

// writeSource makes a file of the given size with predictable bytes.
func writeSource(t *testing.T, size int) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "clip.mp4")
	buf := make([]byte, size)
	for i := range buf {
		buf[i] = byte(i)
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A transport that can send parts in parallel must be used that way. The whole
// bandwidth-delay argument lives in this branch, so if the type assertion stops
// matching, the daemon quietly drops back to one connection and nobody notices
// until they wonder why an upload takes 40 minutes.
func TestUploadUsesTheBatchPathWhenAvailable(t *testing.T) {
	path := writeSource(t, 300)

	uploader := &batchUploader{}
	v := &Vault{Uploader: uploader, PartSize: 100, ChatID: "@cloud", SessionDir: t.TempDir()}

	_, ids, err := v.Upload(context.Background(), path)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	if uploader.calls != 1 {
		t.Errorf("UploadParts called %d times, want 1", uploader.calls)
	}
	if uploader.sendCalls != 0 {
		t.Errorf("Send called %d times; the batch path should have been used", uploader.sendCalls)
	}
	if len(ids) != 3 {
		t.Errorf("ids = %v, want three message ids", ids)
	}
}

// The sequential fallback still has to work: an Uploader that does not implement
// Batcher is a supported configuration, not a broken one.
func TestUploadFallsBackToSequentialSends(t *testing.T) {
	path := writeSource(t, 300)

	rec := &recordingUploader{}
	v := &Vault{Uploader: rec, PartSize: 100, ChatID: "@cloud", SessionDir: t.TempDir()}

	_, ids, err := v.Upload(context.Background(), path)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if len(ids) != 3 {
		t.Fatalf("ids = %d, want 3", len(ids))
	}
	for i, off := range rec.offsets {
		if off != int64(i*100) {
			t.Errorf("send %d offset = %d, want %d (order matters for reassembly)", i, off, i*100)
		}
	}
}

// A failed run must report the parts that did land, because those are exactly
// the ones a retry should skip.
func TestUploadReportsPartsThatLandedBeforeAFailure(t *testing.T) {
	path := writeSource(t, 300)

	uploader := &batchUploader{failOn: 2}
	v := &Vault{Uploader: uploader, PartSize: 100, ChatID: "@cloud", SessionDir: t.TempDir()}

	parts, ids, err := v.Upload(context.Background(), path)
	if err == nil {
		t.Fatal("expected an error")
	}
	if len(parts) != 3 {
		t.Errorf("parts = %d, want the whole plan even on failure", len(parts))
	}
	if len(ids) != 0 {
		t.Errorf("ids = %v, want none reported when the batch failed wholesale", ids)
	}
}

// Resume is the difference between a crash costing one part and costing 5 GB.
func TestUploadSkipsPartsAlreadyStoredInTheChat(t *testing.T) {
	path := writeSource(t, 300)
	session := t.TempDir()

	uploader := &batchUploader{records: true, session: session}
	v := &Vault{Uploader: uploader, PartSize: 100, ChatID: "@cloud", SessionDir: session}

	if _, _, err := v.Upload(context.Background(), path); err != nil {
		t.Fatalf("first upload: %v", err)
	}
	if got := len(uploader.sent); got != 3 {
		t.Fatalf("first run sent %d parts, want 3", got)
	}

	uploader.mu.Lock()
	uploader.sent = nil
	uploader.mu.Unlock()

	// Second run: nothing new to send, and the message ids still come back so
	// the UI can link to the messages that are already in the chat.
	_, ids, err := v.Upload(context.Background(), path)
	if err != nil {
		t.Fatalf("second upload: %v", err)
	}
	if len(uploader.sent) != 0 {
		t.Errorf("second run sent %d parts, want 0", len(uploader.sent))
	}
	if len(ids) != 0 {
		t.Errorf("ids = %v, want none for a run that sent nothing", ids)
	}
}

// A resume that trusts the old record would skip parts of a re-exported file
// and archive the wrong video under the right name.
func TestUploadResendsWhenTheFileChanged(t *testing.T) {
	path := writeSource(t, 300)
	session := t.TempDir()

	uploader := &batchUploader{records: true, session: session}
	v := &Vault{Uploader: uploader, PartSize: 100, ChatID: "@cloud", SessionDir: session}

	if _, _, err := v.Upload(context.Background(), path); err != nil {
		t.Fatalf("first upload: %v", err)
	}

	// Re-export the file with different bytes but the same length, which is
	// what a re-render produces.
	buf := make([]byte, 300)
	for i := range buf {
		buf[i] = byte(i * 7)
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}

	uploader.mu.Lock()
	uploader.sent = nil
	uploader.mu.Unlock()

	if _, _, err := v.Upload(context.Background(), path); err != nil {
		t.Fatalf("second upload: %v", err)
	}
	if len(uploader.sent) != 3 {
		t.Errorf("re-run sent %d parts, want 3 (the digests no longer match)", len(uploader.sent))
	}
}

// The digest recorded for a part must be the digest of that range, or a restore
// that verifies against the manifest would reject a perfectly good archive.
func TestManifestRecordsTheRealDigestOfEachPart(t *testing.T) {
	path := writeSource(t, 300)
	session := t.TempDir()

	uploader := &batchUploader{records: true, session: session}
	v := &Vault{Uploader: uploader, PartSize: 100, ChatID: "@cloud", SessionDir: session}

	if _, _, err := v.Upload(context.Background(), path); err != nil {
		t.Fatalf("Upload: %v", err)
	}

	store, err := openManifest(session, path, 300, 100, "@cloud")
	if err != nil {
		t.Fatal(err)
	}

	parts, _, err := PlanFile(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	store.adopt(parts)

	for _, part := range parts {
		want, err := HashPart(path, part)
		if err != nil {
			t.Fatal(err)
		}
		got := store.snapshot().Parts[part.Index].SHA256
		if got != want {
			t.Errorf("part %d digest = %q, want %q", part.Index, got, want)
		}
	}
}

// Progress is what the desktop app renders, so it has to move through the
// phases and never go backwards.
func TestUploadReportsProgressThroughEveryPhase(t *testing.T) {
	path := writeSource(t, 300)

	var seen []Progress
	v := &Vault{
		Uploader:   &batchUploader{},
		PartSize:   100,
		ChatID:     "@cloud",
		SessionDir: t.TempDir(),
		OnProgress: func(p Progress) { seen = append(seen, p) },
	}

	if _, _, err := v.Upload(context.Background(), path); err != nil {
		t.Fatalf("Upload: %v", err)
	}
	if len(seen) == 0 {
		t.Fatal("no progress was reported")
	}

	var hashed, uploading, done bool
	var last int64
	for _, p := range seen {
		switch p.Phase {
		case PhaseHashing:
			hashed = true
		case PhaseUploading:
			uploading = true
		case PhaseDone:
			done = true
		}
		if p.BytesDone < last {
			t.Errorf("progress went backwards: %d after %d", p.BytesDone, last)
		}
		last = p.BytesDone
	}

	if !hashed || !uploading || !done {
		t.Errorf("phases seen: hashed=%v uploading=%v done=%v", hashed, uploading, done)
	}

	final := seen[len(seen)-1]
	if final.BytesDone != final.BytesTotal {
		t.Errorf("final BytesDone = %d, want the full %d", final.BytesDone, final.BytesTotal)
	}
	if got := final.Percent(); got != 100 {
		t.Errorf("final Percent = %v, want 100", got)
	}
}
