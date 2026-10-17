package vault

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestPlanSplitsLargeFile(t *testing.T) {
	const size = 5_000_000_000 // 5 GB source
	parts, err := Plan("D:/videos/lecture.mp4", size, DefaultPartBytes)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}

	if len(parts) != 3 {
		t.Fatalf("got %d parts, want 3", len(parts))
	}

	// Parts must tile the file exactly: no gaps, no overlaps, no overflow.
	var covered int64
	for i, p := range parts {
		if p.Offset != covered {
			t.Errorf("part %d offset = %d, want %d (gap or overlap)", i, p.Offset, covered)
		}
		if p.Size > MaxTelegramFileBytes {
			t.Errorf("part %d size %d exceeds the Telegram limit", i, p.Size)
		}
		covered += p.Size
	}
	if covered != size {
		t.Errorf("parts cover %d bytes, want %d", covered, size)
	}
}

func TestPlanSinglePartForSmallFile(t *testing.T) {
	parts, err := Plan("clip.mp4", 120_000_000, DefaultPartBytes)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}

	if len(parts) != 1 {
		t.Fatalf("got %d parts, want 1", len(parts))
	}
	if parts[0].Name != "clip.mp4" {
		t.Errorf("single part should keep the original name, got %q", parts[0].Name)
	}
	if parts[0].Offset != 0 || parts[0].Size != 120_000_000 {
		t.Errorf("unexpected part %+v", parts[0])
	}
}

func TestPlanNamesParts(t *testing.T) {
	parts, err := Plan("C:/videos/lecture.mp4", 4_000_000_000, 2_000_000_000)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}

	want := []string{"lecture.part1.mp4", "lecture.part2.mp4"}
	for i, w := range want {
		if parts[i].Name != w {
			t.Errorf("part %d name = %q, want %q", i, parts[i].Name, w)
		}
	}
}

func TestPlanHandlesExtensionlessName(t *testing.T) {
	parts, err := Plan("backup", 3_000_000_000, 2_000_000_000)
	if err != nil {
		t.Fatalf("Plan: %v", err)
	}
	if parts[0].Name != "backup.part1" {
		t.Errorf("name = %q, want backup.part1", parts[0].Name)
	}
}

func TestPlanRejectsEmptyFile(t *testing.T) {
	if _, err := Plan("empty.mp4", 0, DefaultPartBytes); err == nil {
		t.Fatal("expected an error for a zero-byte file")
	}
}

func TestPlanRejectsOversizedPart(t *testing.T) {
	_, err := Plan("clip.mp4", 5_000_000_000, MaxTelegramFileBytes+1)
	if err == nil {
		t.Fatal("expected an error when the part size exceeds the Telegram limit")
	}
}

func TestPlanFileUsesRealSize(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(path, make([]byte, 2500), 0o600); err != nil {
		t.Fatal(err)
	}

	parts, size, err := PlanFile(path, 1000)
	if err != nil {
		t.Fatalf("PlanFile: %v", err)
	}
	if size != 2500 {
		t.Errorf("size = %d, want 2500", size)
	}
	if len(parts) != 3 {
		t.Fatalf("got %d parts, want 3", len(parts))
	}
	if parts[2].Size != 500 {
		t.Errorf("last part size = %d, want 500", parts[2].Size)
	}
}

func TestUnconfiguredVaultRefusesClearly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(path, make([]byte, 500), 0o600); err != nil {
		t.Fatal(err)
	}

	v := Unconfigured()

	// Planning must still work so the UI can preview the split before any
	// credentials exist.
	parts, size, err := v.Planned(path)
	if err != nil {
		t.Fatalf("Planned: %v", err)
	}
	if size != 500 || len(parts) != 1 {
		t.Fatalf("size=%d parts=%d, want 500 and 1", size, len(parts))
	}

	// Uploading without an uploader must refuse with a reason the UI can show.
	_, _, err = v.Upload(context.Background(), path)
	if !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("Upload error = %v, want ErrNotConfigured", err)
	}
}

func TestUploadSendsEveryPartInOrder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(path, make([]byte, 300), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := &recordingUploader{}
	v := &Vault{Uploader: rec, PartSize: 100, ChatID: "chat1"}

	parts, ids, err := v.Upload(context.Background(), path)
	if err != nil {
		t.Fatalf("Upload: %v", err)
	}

	if len(parts) != 3 || len(ids) != 3 {
		t.Fatalf("parts=%d ids=%d, want 3 and 3", len(parts), len(ids))
	}
	for i, off := range rec.offsets {
		if off != int64(i*100) {
			t.Errorf("send %d offset = %d, want %d (order matters for reassembly)", i, off, i*100)
		}
	}
}

func TestUploadStopsOnFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(path, make([]byte, 300), 0o600); err != nil {
		t.Fatal(err)
	}

	rec := &recordingUploader{failAt: 2} // fail on the SECOND part
	v := &Vault{Uploader: rec, PartSize: 100, ChatID: "chat1"}

	_, ids, err := v.Upload(context.Background(), path)
	if err == nil {
		t.Fatal("expected an error")
	}
	if len(ids) != 1 {
		t.Errorf("ids = %d, want 1 (should stop at the failure)", len(ids))
	}
	if len(rec.offsets) != 2 {
		t.Errorf("made %d send attempts, want 2 (no retry past the failure)", len(rec.offsets))
	}
}

type recordingUploader struct {
	offsets []int64
	failAt  int // 0 = never fail; otherwise fail on the Nth send (1-based)
}

func (r *recordingUploader) Send(_ context.Context, _, _ string, offset, _ int64) (int, error) {
	r.offsets = append(r.offsets, offset)
	if r.failAt > 0 && len(r.offsets) == r.failAt {
		return 0, errors.New("network died mid-upload")
	}
	return 1000 + len(r.offsets), nil
}

func (r *recordingUploader) Authorise(context.Context) error { return nil }
func (r *recordingUploader) Authorised() bool                { return true }
