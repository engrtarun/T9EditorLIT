package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// An interrupted upload must cost one part, not the file. That only holds if the
// record of what is already stored survives the process, which is what these
// tests exercise against a real directory.
func TestManifestRoundTripsThroughDisk(t *testing.T) {
	dir := t.TempDir()
	parts := []Part{
		{Index: 0, Offset: 0, Size: 1000, Name: "clip.part1.mp4"},
		{Index: 1, Offset: 1000, Size: 1000, Name: "clip.part2.mp4"},
	}
	digests := []string{"aaa", "bbb"}

	store, err := openManifest(dir, "D:/videos/clip.mp4", 2000, 1000, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	store.seed(parts, digests)
	store.setUser("cloud")
	store.record(0, 4242, "https://t.me/cloud/4242")

	// A second run must find the first part already stored.
	again, err := openManifest(dir, "D:/videos/clip.mp4", 2000, 1000, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	again.seed(parts, digests)

	skip := again.skipSet()
	if !skip[0] {
		t.Error("part 0 was recorded as stored but the resume did not skip it")
	}
	if skip[1] {
		t.Error("part 1 was never sent but the resume skipped it")
	}

	snapshot := again.snapshot()
	if snapshot.StoredCount() != 1 {
		t.Errorf("StoredCount = %d, want 1", snapshot.StoredCount())
	}
	if snapshot.Parts[0].Link != "https://t.me/cloud/4242" {
		t.Errorf("link = %q, want it preserved", snapshot.Parts[0].Link)
	}
	if snapshot.Complete {
		t.Error("Complete should be false while a part is still missing")
	}
}

// The dangerous resume is one that trusts a stale record. If the file was
// re-exported after a failed upload, the bytes at a given offset are different,
// and skipping them would archive the wrong video under a reassuring name.
func TestManifestDropsStoredPartsWhenTheDigestChanges(t *testing.T) {
	dir := t.TempDir()
	parts := []Part{{Index: 0, Offset: 0, Size: 1000, Name: "clip.mp4"}}

	store, err := openManifest(dir, "D:/videos/clip.mp4", 1000, 1000, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	store.seed(parts, []string{"original-digest"})
	store.record(0, 777, "")

	cases := []struct {
		name   string
		digest string
		want   bool // should the part still be skipped?
	}{
		{"same bytes", "original-digest", true},
		{"different bytes", "different-digest", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reopened, err := openManifest(dir, "D:/videos/clip.mp4", 1000, 1000, "@cloud")
			if err != nil {
				t.Fatal(err)
			}
			reopened.seed(parts, []string{tc.digest})

			if got := reopened.skipSet()[0]; got != tc.want {
				t.Errorf("skipped = %v, want %v (a resume must re-check the digest)", got, tc.want)
			}
		})
	}
}

// A different size is a different file, so it gets a different record rather
// than resuming onto the old one.
func TestManifestPathVariesWithSize(t *testing.T) {
	dir := t.TempDir()
	a := manifestPathFor(dir, "D:/videos/clip.mp4", 1000)
	b := manifestPathFor(dir, "D:/videos/clip.mp4", 2000)
	c := manifestPathFor(dir, "D:/videos/clip.mp4", 1000)

	if a == b {
		t.Error("a different file size must not share a resume record")
	}
	if a != c {
		t.Error("the same source and size must map to the same record")
	}
	if filepath.Dir(a) != manifestDir(dir) {
		t.Errorf("manifests must live under the session directory, got %s", a)
	}
}

// A corrupt scratch file must not stop an upload. Losing the resume costs one
// re-send; refusing to send at all costs the whole backup.
func TestManifestIgnoresCorruptFile(t *testing.T) {
	dir := t.TempDir()
	path := manifestPathFor(dir, "D:/videos/clip.mp4", 1000)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	store, err := openManifest(dir, "D:/videos/clip.mp4", 1000, 1000, "@cloud")
	if err != nil {
		t.Fatalf("a corrupt resume file must not be a hard error: %v", err)
	}
	if len(store.snapshot().Parts) != 0 {
		t.Error("expected a fresh manifest")
	}
}

// Workers record their parts from separate goroutines. A half-written file would
// be read as "no manifest" next run, silently turning a resume into a full
// re-send — so the write path has to be safe under concurrency.
func TestManifestRecordIsSafeUnderConcurrency(t *testing.T) {
	dir := t.TempDir()
	const parts = 8

	plan := make([]Part, parts)
	digests := make([]string, parts)
	for i := range plan {
		plan[i] = Part{Index: i, Offset: int64(i * 100), Size: 100, Name: "clip.mp4"}
		digests[i] = "digest"
	}

	store, err := openManifest(dir, "D:/videos/clip.mp4", parts*100, 100, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	store.seed(plan, digests)

	var wg sync.WaitGroup
	for i := range plan {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			store.record(i, 1000+i, "")
		}(i)
	}
	wg.Wait()

	raw, err := os.ReadFile(manifestPathFor(dir, "D:/videos/clip.mp4", parts*100))
	if err != nil {
		t.Fatal(err)
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("the resume file is not valid JSON after concurrent writes: %v", err)
	}
	if m.StoredCount() != parts {
		t.Errorf("StoredCount = %d, want %d", m.StoredCount(), parts)
	}
	if !m.Complete {
		t.Error("Complete should be true once every part is stored")
	}
}

func TestManifestAdoptPreservesStoredIDs(t *testing.T) {
	dir := t.TempDir()
	plan := []Part{
		{Index: 0, Offset: 0, Size: 100, Name: "clip.part1.mp4"},
		{Index: 1, Offset: 100, Size: 100, Name: "clip.part2.mp4"},
	}

	store, err := openManifest(dir, "D:/videos/clip.mp4", 200, 100, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	store.seed(plan, []string{"a", "b"})
	store.record(0, 11, "")

	// A fresh store adopts the plan without digests and must still know that
	// part 0 is in the chat, otherwise recording part 1 would lose part 0.
	fresh, err := openManifest(dir, "D:/videos/clip.mp4", 200, 100, "@cloud")
	if err != nil {
		t.Fatal(err)
	}
	fresh.adopt(plan)

	if !fresh.skipSet()[0] {
		t.Error("adopt dropped a stored message id")
	}
	if fresh.skipSet()[1] {
		t.Error("adopt invented a stored part")
	}
}
