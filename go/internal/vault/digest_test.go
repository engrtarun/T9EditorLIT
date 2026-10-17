package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// writeRangeFile makes a file whose bytes are predictable per offset, so a
// digest mismatch points at the plumbing rather than at the fixture.
func writeRangeFile(t *testing.T, size int) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "source.bin")
	buf := make([]byte, size)
	for i := range buf {
		buf[i] = byte(i % 251)
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func digestOf(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestHashRangeMatchesTheSlice(t *testing.T) {
	const size = 5000
	path := writeRangeFile(t, size)
	whole, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		offset, size int64
	}{
		{0, size},
		{0, 1},
		{100, 2500},
		{4999, 1},
		{2500, 2500},
		{4096, 0}, // a zero-length part still has a digest
	}

	for _, tt := range tests {
		got, err := HashRange(path, tt.offset, tt.size)
		if err != nil {
			t.Fatalf("HashRange(%d,%d): %v", tt.offset, tt.size, err)
		}
		want := digestOf(whole[tt.offset : tt.offset+tt.size])
		if got != want {
			t.Errorf("HashRange(%d,%d) = %s, want %s", tt.offset, tt.size, got, want)
		}
	}
}

func TestHashPartUsesThePlan(t *testing.T) {
	const size = 1000
	path := writeRangeFile(t, size)

	part := Part{Index: 1, Offset: 250, Size: 500, Name: "clip.part2.mp4"}
	got, err := HashPart(path, part)
	if err != nil {
		t.Fatal(err)
	}

	whole, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := digestOf(whole[250:750]); got != want {
		t.Errorf("HashPart = %s, want %s", got, want)
	}
}

func TestHashRangeRejectsNegativeRange(t *testing.T) {
	path := writeRangeFile(t, 100)
	if _, err := HashRange(path, -1, 10); err == nil {
		t.Error("expected an error for a negative offset")
	}
	if _, err := HashRange(path, 0, -5); err == nil {
		t.Error("expected an error for a negative size")
	}
}

// Upload workers hash parts concurrently. They must not share a file position:
// one handle with several Seeks is exactly how the wrong bytes end up in
// Telegram under a correct-looking name.
func TestHashRangeIsSafeUnderConcurrency(t *testing.T) {
	const size = 200_000
	path := writeRangeFile(t, size)

	whole, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	type span struct{ offset, length int64 }
	spans := []span{
		{0, 50_000},
		{50_000, 50_000},
		{100_000, 50_000},
		{150_000, 50_000},
		{10_000, 130_000},
	}

	var wg sync.WaitGroup
	failures := make([]string, len(spans))
	for i, s := range spans {
		wg.Add(1)
		go func(i int, s span) {
			defer wg.Done()
			got, err := HashRange(path, s.offset, s.length)
			if err != nil {
				failures[i] = err.Error()
				return
			}
			if want := digestOf(whole[s.offset : s.offset+s.length]); got != want {
				failures[i] = "digest mismatch: a concurrent read moved the shared handle"
			}
		}(i, s)
	}
	wg.Wait()

	for i, msg := range failures {
		if msg != "" {
			t.Errorf("span %d: %s", i, msg)
		}
	}
}

// Telegram's own uploader must never be tempted to grow a buffer to hold a
// whole part. This constant is the RAM ceiling per connection, so it is pinned
// by a test rather than by a comment.
func TestUploadPartSizeStaysSmall(t *testing.T) {
	if UploadPartBytes > 1<<20 {
		t.Errorf("UploadPartBytes = %d, want at most 1 MiB per buffer", UploadPartBytes)
	}
	if HashBufferBytes > 1<<20 {
		t.Errorf("HashBufferBytes = %d, want at most 1 MiB per buffer", HashBufferBytes)
	}

	// Worst case RAM while uploading: one buffer per in-flight part per
	// connection, times the connection pool. Spelled out here because the whole
	// project exists to keep this number small.
	perConnection := UploadPartBytes * uploadThreads
	worstCase := perConnection * MaxConnections
	if worstCase > 16<<20 {
		t.Errorf("worst-case upload buffers = %d bytes, want under 16 MiB", worstCase)
	}
	t.Logf("worst-case upload buffers: %.1f MiB across %d connections",
		float64(worstCase)/(1<<20), MaxConnections)
}

func TestMimeFor(t *testing.T) {
	tests := map[string]string{
		"clip.mp4":      "video/mp4",
		"CLIP.MP4":      "video/mp4",
		"lecture.mkv":   "video/x-matroska",
		"archive.zip":   "application/zip",
		"manifest.json": "application/json",
		"no-extension":  "application/octet-stream",
		"weird.xyz":     "application/octet-stream",
	}

	for name, want := range tests {
		if got := MimeFor(name); got != want {
			t.Errorf("MimeFor(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestHumanBytes(t *testing.T) {
	tests := []struct {
		in   int64
		want string
	}{
		{0, "0 B"},
		{999, "999 B"},
		{1_000, "1.00 kB"},
		{1_900_000_000, "1.90 GB"},
		{5_000_000_000, "5.00 GB"},
	}
	for _, tt := range tests {
		if got := humanBytes(tt.in); got != tt.want {
			t.Errorf("humanBytes(%d) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
