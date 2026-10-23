package vault

// Offline tests for the restore path (restore.go + the Fetcher contract).
//
// The transport is replaced by a fake that serves the bytes the "chat" would
// hold, so every behaviour here is exercised without talking to Telegram:
// the round trips, the resume rules (both the record and the re-verified
// temp file), the digest and truncation refusals, the destination rules, and
// the restore menu listing.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// fakeFetcher serves stored parts from an in-memory map. It follows the
// Fetcher contract the real transport follows: bytes are proven against the
// manifest digest before anything is recorded, a truncated stream is refused
// and its temp file removed, and a temp that rots after verification is
// caught by the join's size check rather than being joined silently.
type fakeFetcher struct {
	sessionDir string

	mu    sync.Mutex
	store map[int][]byte // messageID → bytes the "chat" holds
	calls []int          // part indexes actually fetched

	// rotAfterFetch simulates disk decay between the fetch and the join:
	// every fetched part is recorded first (so the run proceeds to the
	// join) and then truncated.
	rotAfterFetch bool
}

func (f *fakeFetcher) Send(ctx context.Context, chatID, path string, offset, size int64) (int, error) {
	return 0, errors.New("fake fetcher does not upload")
}

func (f *fakeFetcher) Authorise(ctx context.Context) error { return nil }

func (f *fakeFetcher) Authorised() bool { return true }

func (f *fakeFetcher) FetchParts(
	ctx context.Context,
	chatID string,
	m Manifest,
	fetch []int,
	destDir string,
	base int64,
	report func(Progress),
) error {
	name, err := RestoreName(m.Source)
	if err != nil {
		return err
	}
	store, err := openRestoreManifest(f.sessionDir, &m, destDir, name)
	if err != nil {
		return err
	}

	for _, i := range fetch {
		part := m.Parts[i]
		data, ok := f.store[part.MessageID]
		if !ok {
			return fmt.Errorf("fake vault holds no message %d", part.MessageID)
		}

		tmp, perr := RestoreTempPath(destDir, name, part.Index)
		if perr != nil {
			return perr
		}
		if werr := os.WriteFile(tmp, data, 0o600); werr != nil {
			return werr
		}

		f.mu.Lock()
		f.calls = append(f.calls, part.Index)
		f.mu.Unlock()

		// The refusals, in the order the real transport judges them.
		if int64(len(data)) != part.Size {
			_ = os.Remove(tmp)
			return fmt.Errorf("fake stream stopped after %d of %d bytes",
				len(data), part.Size)
		}
		sum := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), part.SHA256) {
			_ = os.Remove(tmp)
			return fmt.Errorf("digest mismatch after download: the chat's bytes do not match the manifest")
		}

		store.recordDone(part.Index)
	}

	if f.rotAfterFetch {
		for _, i := range fetch {
			tmp, perr := RestoreTempPath(destDir, name, m.Parts[i].Index)
			if perr != nil {
				return perr
			}
			if terr := os.Truncate(tmp, 17); terr != nil {
				return terr
			}
		}
	}
	return nil
}

func (f *fakeFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// minimalUploader satisfies Uploader only, for the "cannot fetch" refusal.
type minimalUploader struct{}

func (minimalUploader) Send(ctx context.Context, chatID, path string, offset, size int64) (int, error) {
	return 0, errors.New("not used")
}

func (minimalUploader) Authorise(ctx context.Context) error { return nil }

func (minimalUploader) Authorised() bool { return true }

// buildManifest plans a source at an explicit part size and hashes each part
// from real disk bytes, the way a finished upload run would record it.
func buildManifest(t *testing.T, source string, partSize int64, ids []int, chat string) Manifest {
	t.Helper()

	size, err := fileSizeOf(source)
	if err != nil {
		t.Fatalf("stat source: %v", err)
	}
	parts, err := Plan(source, size, partSize)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(parts) != len(ids) {
		t.Fatalf("planned %d parts for %d ids", len(parts), len(ids))
	}

	rows := make([]ManifestPart, 0, len(parts))
	for i, p := range parts {
		digest, herr := HashPart(source, p)
		if herr != nil {
			t.Fatalf("hash part %d: %v", i, herr)
		}
		rows = append(rows, ManifestPart{
			Index: p.Index, Offset: p.Offset, Size: p.Size,
			Name: p.Name, SHA256: digest, MessageID: ids[i],
		})
	}
	return Manifest{
		Version:    ManifestVersion,
		Source:     filepath.Clean(source),
		SourceSize: size,
		PartSize:   partSize,
		Chat:       chat,
		Parts:      rows,
		Complete:   true,
		Updated:    1,
	}
}

func fileSizeOf(path string) (int64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return fi.Size(), nil
}

// fillFakeStore reads each planned part's slice out of the source file.
func fillFakeStore(t *testing.T, source string, m Manifest) map[int][]byte {
	t.Helper()

	f, err := os.Open(source)
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	defer f.Close()

	store := make(map[int][]byte, len(m.Parts))
	for _, row := range m.Parts {
		buf := make([]byte, row.Size)
		if _, err := f.ReadAt(buf, row.Offset); err != nil {
			t.Fatalf("read part %d: %v", row.Index, err)
		}
		store[row.MessageID] = buf
	}
	return store
}

func newRestoreVault(sessionDir string, up Uploader) *Vault {
	return &Vault{
		Uploader:   up,
		PartSize:   DefaultPartBytes,
		ChatID:     "@restore-tests",
		SessionDir: sessionDir,
	}
}

func listTempFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), restoreTempPrefix) {
			out = append(out, e.Name())
		}
	}
	return out
}

// ── round trips ─────────────────────────────────────────────────────────

func TestRestoreSinglePartRoundTrip(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 150*1024+7)
	m := buildManifest(t, source, DefaultPartBytes, []int{1001}, "@restore-tests")

	fake := &fakeFetcher{sessionDir: sessionDir, store: fillFakeStore(t, source, m)}
	v := newRestoreVault(sessionDir, fake)

	final, err := v.Restore(context.Background(), m, destDir)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	want := filepath.Join(destDir, filepath.Base(source))
	if final != want {
		t.Errorf("final = %q, want %q", final, want)
	}
	got, rerr := os.ReadFile(final)
	if rerr != nil {
		t.Fatalf("read restored: %v", rerr)
	}
	raw, werr := os.ReadFile(source)
	if werr != nil || !bytes.Equal(got, raw) {
		t.Error("restored bytes differ from the source")
	}
	if leftovers := listTempFiles(t, destDir); len(leftovers) != 0 {
		t.Errorf("restore left temp files behind: %v", leftovers)
	}
}

func TestRestoreMultiPartRoundTripAndProgress(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	const partSize = 32_768
	m := buildManifest(t, source, partSize, []int{11, 12, 13}, "@restore-tests")

	var reported []Progress
	fake := &fakeFetcher{sessionDir: sessionDir, store: fillFakeStore(t, source, m)}
	v := newRestoreVault(sessionDir, fake)
	v.OnProgress = func(p Progress) { reported = append(reported, p) }

	final, err := v.Restore(context.Background(), m, destDir)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	got, rerr := os.ReadFile(final)
	raw, _ := os.ReadFile(source)
	if rerr != nil || !bytes.Equal(got, raw) {
		t.Fatal("the joined file does not reproduce the source")
	}
	if fake.callCount() != 3 {
		t.Errorf("fetch calls = %d, want 3", fake.callCount())
	}

	if len(reported) == 0 {
		t.Fatal("no progress was reported")
	}
	last := reported[len(reported)-1]
	if last.Phase != PhaseDone {
		t.Errorf("final phase = %q, want %q", last.Phase, PhaseDone)
	}
	if last.BytesDone != m.SourceSize || last.BytesTotal != m.SourceSize {
		t.Errorf("final bytes = %d/%d, want %d/%d",
			last.BytesDone, last.BytesTotal, m.SourceSize, m.SourceSize)
	}
	phases := map[string]bool{}
	for _, p := range reported {
		phases[p.Phase] = true
	}
	for _, want := range []string{PhaseVerifying, PhaseDownloading, PhaseJoining, PhaseDone} {
		if !phases[want] {
			t.Errorf("progress never reported phase %q", want)
		}
	}
}

// ── the resume rules ────────────────────────────────────────────────────

func TestRestoreResumesFromTempsOnDisk(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{21, 22, 23}, "@restore-tests")

	name, err := RestoreName(m.Source)
	if err != nil {
		t.Fatalf("restore name: %v", err)
	}

	// Pretend an earlier run downloaded everything and died before the join.
	slices := fillFakeStore(t, source, m)
	for _, row := range m.Parts {
		tmp, terr := RestoreTempPath(destDir, name, row.Index)
		if terr != nil {
			t.Fatalf("temp path: %v", terr)
		}
		if werr := os.WriteFile(tmp, slices[row.MessageID], 0o600); werr != nil {
			t.Fatalf("write temp: %v", werr)
		}
	}
	if temps := listTempFiles(t, destDir); len(temps) != len(m.Parts) {
		t.Fatalf("temps on disk = %d, want %d", len(temps), len(m.Parts))
	}

	fake := &fakeFetcher{sessionDir: sessionDir, store: slices}
	v := newRestoreVault(sessionDir, fake)

	final, err := v.Restore(context.Background(), m, destDir)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if fake.callCount() != 0 {
		t.Errorf("the resume fetched %d parts that were already on disk", fake.callCount())
	}

	raw, _ := os.ReadFile(source)
	got, rerr := os.ReadFile(final)
	if rerr != nil || !bytes.Equal(got, raw) {
		t.Error("resumed restore does not reproduce the source")
	}
}

func TestRestoreResumesMiddleOfRun(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{31, 32, 33}, "@restore-tests")

	name, _ := RestoreName(m.Source)
	slices := fillFakeStore(t, source, m)

	// Part 0 finished in an earlier attempt and the record says so; part 1
	// started and died, leaving a live temp; part 2 never began.
	store, err := openRestoreManifest(sessionDir, &m, destDir, name)
	if err != nil {
		t.Fatalf("open restore record: %v", err)
	}
	store.recordDone(0)

	tmp0, _ := RestoreTempPath(destDir, name, 0)
	if werr := os.WriteFile(tmp0, slices[31], 0o600); werr != nil {
		t.Fatal(werr)
	}
	tmp1, _ := RestoreTempPath(destDir, name, 1)
	if werr := os.WriteFile(tmp1, slices[32], 0o600); werr != nil {
		t.Fatal(werr)
	}

	fake := &fakeFetcher{sessionDir: sessionDir, store: slices}
	v := newRestoreVault(sessionDir, fake)

	final, err := v.Restore(context.Background(), m, destDir)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}

	// The record accounts for part 0, the re-verified temp for part 1, so
	// only part 2 crosses the network.
	if got := fake.callCount(); got != 1 {
		t.Errorf("fetch calls = %d, want 1 (part 2 only)", got)
	}
	raw, _ := os.ReadFile(source)
	got, rerr := os.ReadFile(final)
	if rerr != nil || !bytes.Equal(got, raw) {
		t.Error("resumed restore does not reproduce the source")
	}
}

// ── the refusal rules ───────────────────────────────────────────────────

func TestRestoreRefusesCorruptedPart(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{41, 42, 43}, "@restore-tests")

	slices := fillFakeStore(t, source, m)
	// Same size, different bytes: the worst kind of lie a network can tell.
	bad := make([]byte, len(slices[42]))
	copy(bad, slices[42])
	for i := range bad {
		bad[i] = ^bad[i]
	}
	slices[42] = bad

	name, _ := RestoreName(m.Source)
	fake := &fakeFetcher{sessionDir: sessionDir, store: slices}
	v := newRestoreVault(sessionDir, fake)

	_, err := v.Restore(context.Background(), m, destDir)
	if err == nil {
		t.Fatal("a corrupted part must not pass silently")
	}
	if !strings.Contains(err.Error(), "digest") {
		t.Errorf("error should name the digest mismatch, got %v", err)
	}

	// The bad part's temp file must be gone, and no final file may exist.
	tmp, _ := RestoreTempPath(destDir, name, 1)
	if _, statErr := os.Stat(tmp); !errors.Is(statErr, os.ErrNotExist) {
		t.Error("the corrupted part's temp file was not removed")
	}
	if _, statErr := os.Stat(filepath.Join(destDir, name)); !errors.Is(statErr, os.ErrNotExist) {
		t.Error("a partial file was left in the destination")
	}
}

func TestRestoreRefusesTruncatedPart(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{51, 52, 53}, "@restore-tests")

	slices := fillFakeStore(t, source, m)
	slices[52] = slices[52][:20_000] // the chat's part got cut short

	fake := &fakeFetcher{sessionDir: sessionDir, store: slices}
	v := newRestoreVault(sessionDir, fake)

	_, err := v.Restore(context.Background(), m, destDir)
	if err == nil {
		t.Fatal("a truncated part must not be joined")
	}
	if !strings.Contains(err.Error(), "stopped") {
		t.Errorf("error should refuse the short stream, got %v", err)
	}

	name, _ := RestoreName(m.Source)
	if _, statErr := os.Stat(filepath.Join(destDir, name)); !errors.Is(statErr, os.ErrNotExist) {
		t.Error("no file may appear in the destination after a refused part")
	}
}

// TestRestoreRefusesRottingTempDuringJoin runs a fully successful fetch and
// then lets disk decay hit the temp files before the join. The join is the
// last line of defence: byte counts are re-checked there, because a part
// that was verified at download time does not stay verified by assumption.
func TestRestoreRefusesRottingTempDuringJoin(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{55, 56, 57}, "@restore-tests")

	fake := &fakeFetcher{sessionDir: sessionDir, store: fillFakeStore(t, source, m), rotAfterFetch: true}
	v := newRestoreVault(sessionDir, fake)

	_, err := v.Restore(context.Background(), m, destDir)
	if err == nil {
		t.Fatal("rotten temps must not join")
	}
	if !strings.Contains(err.Error(), "joining") {
		t.Errorf("error should name the join stage, got %v", err)
	}

	name, _ := RestoreName(m.Source)
	if _, statErr := os.Stat(filepath.Join(destDir, name)); !errors.Is(statErr, os.ErrNotExist) {
		t.Error("the failed join must not leave a file in the destination")
	}
}

func TestRestoreIncompleteVaultIsRefused(t *testing.T) {
	source := writeSource(t, 70_000)
	m := buildManifest(t, source, 32_768, []int{61, 62, 0}, "@restore-tests")
	m.Parts[0].MessageID = 0 // one part never made it to the chat

	v := newRestoreVault(t.TempDir(), &fakeFetcher{store: nil})
	_, err := v.Restore(context.Background(), m, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "never uploaded") {
		t.Errorf("error should name the unfinished upload, got %v", err)
	}
}

func TestRestoreWithoutFetcherRefusesClearly(t *testing.T) {
	source := writeSource(t, 2_000)
	m := buildManifest(t, source, DefaultPartBytes, []int{71}, "@restore-tests")

	v := newRestoreVault(t.TempDir(), minimalUploader{})
	_, err := v.Restore(context.Background(), m, t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "cannot fetch") {
		t.Errorf("error should explain the missing capability, got %v", err)
	}
}

// ── destination rules ───────────────────────────────────────────────────

func TestRestoreIdempotentWhenFinalExists(t *testing.T) {
	sessionDir := t.TempDir()
	destDir := t.TempDir()

	source := writeSource(t, 2_000)
	m := buildManifest(t, source, DefaultPartBytes, []int{81}, "@restore-tests")

	fake := &fakeFetcher{sessionDir: sessionDir, store: fillFakeStore(t, source, m)}
	v := newRestoreVault(sessionDir, fake)

	// A file already sitting there with the exact recorded size: the second
	// restore costs nothing, and no fetch happens.
	if werr := os.WriteFile(filepath.Join(destDir, filepath.Base(source)), make([]byte, 2_000), 0o600); werr != nil {
		t.Fatal(werr)
	}

	final, err := v.Restore(context.Background(), m, destDir)
	if err != nil || final != filepath.Join(destDir, filepath.Base(source)) {
		t.Fatalf("restore = %q, %v", final, err)
	}
	if fake.callCount() != 0 {
		t.Errorf("a completed restore must not fetch anything, got %d calls", fake.callCount())
	}

	// A different file wearing the same name is where the line is drawn.
	if werr := os.WriteFile(filepath.Join(destDir, filepath.Base(source)), []byte("previously unrelated bytes"), 0o600); werr != nil {
		t.Fatal(werr)
	}
	_, err = v.Restore(context.Background(), m, destDir)
	if err == nil || !strings.Contains(err.Error(), "refusing to restore") {
		t.Errorf("error should refuse the overwrite, got %v", err)
	}
}

func TestRestoreNameRules(t *testing.T) {
	cases := []struct{ in, want string }{
		{filepath.Join(`D:\vault`, `clip <final>.mp4`), "clip _final_.mp4"},
		{`D:\vault\plain.mp4`, "plain.mp4"},
		{"", "vault-restore.bin"},
		{`D:\vault\..`, "vault-restore.bin"},
	}
	for _, tc := range cases {
		if got, err := RestoreName(tc.in); err != nil || got != tc.want {
			t.Errorf("RestoreName(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}

	long := strings.Repeat("n", 250) + ".mp4"
	got, err := RestoreName(filepath.Join(`D:\x`, long))
	if err != nil {
		t.Fatalf("RestoreName(long): %v", err)
	}
	if len(got) > 200 || !strings.HasSuffix(got, ".mp4") {
		t.Errorf("RestoreName(long) = %q (%d bytes); want a ≤200 name keeping .mp4", got, len(got))
	}
}

// ── the listing (restore menu) ──────────────────────────────────────────

func TestStoredBackupsListsCompleteLatestFirst(t *testing.T) {
	sessionDir := t.TempDir()
	source := writeSource(t, 5_000)

	older := buildManifest(t, source, 4_000, []int{91, 92}, "@v")
	older.Updated = 100
	fresh := buildManifest(t, source, DefaultPartBytes, []int{93}, "@v")
	fresh.Updated = 200
	partial := buildManifest(t, source, 4_000, []int{94, 95}, "@v")
	partial.Parts[1].MessageID = 0 // an upload that never finished
	partial.Complete = false

	// Two manifests for one source+size share one derived file name, so the
	// older one and the unfinished one are keyed with distinct names.
	for name, m := range map[string]Manifest{
		"fresh":   fresh,
		"partial": partial,
	} {
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(manifestDir(sessionDir), "upload-"+name+"-x.json")
		if werr := os.WriteFile(path, raw, 0o600); werr != nil {
			t.Fatal(werr)
		}
	}
	rawOlder, err := json.Marshal(older)
	if err != nil {
		t.Fatal(err)
	}
	if werr := os.WriteFile(manifestPathFor(sessionDir, source, 5_000), rawOlder, 0o600); werr != nil {
		t.Fatal(werr)
	}

	v := newRestoreVault(sessionDir, minimalUploader{})
	got := v.StoredBackups()
	if len(got) != 2 {
		t.Fatalf("StoredBackups = %d entries, want 2 (complete only)", len(got))
	}
	if got[0].Updated != 200 {
		t.Errorf("the freshest manifest should come first, got updated=%d", got[0].Updated)
	}
}
