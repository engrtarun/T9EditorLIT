//go:build windows

package dl

import (
	"os"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modkernel32                = windows.NewLazySystemDLL("kernel32.dll")
	procGetCompressedFileSizeW = modkernel32.NewProc("GetCompressedFileSizeW")
)

// allocatedBytes is how much disk the file really occupies — the number that
// matters on a 90 GB download, not the logical size.
//
// GetCompressedFileSizeW takes a *path* (it is the only kernel API that
// reports allocation without a handle), so the file is flushed and closed
// before asking.
func allocatedBytes(t *testing.T, f *os.File) int64 {
	t.Helper()
	path := f.Name()
	if err := f.Sync(); err != nil {
		t.Fatalf("sync: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("utf16: %v", err)
	}
	var high uint32
	low, _, callErr := procGetCompressedFileSizeW.Call(
		uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&high)))
	if uint32(low) == 0xffffffff && callErr != nil && callErr != windows.ERROR_SUCCESS {
		t.Skipf("GetCompressedFileSizeW: %v", callErr)
	}
	return int64(high)<<32 | int64(uint32(low))
}

// TestSparseGapsCostNothing is the regression test for the 45 GB file that was
// all zeros: a plain file cannot have holes, so the first WriteAt past the end
// makes Windows zero-fill and allocate every cluster in between. With sixteen
// segments on a 90 GB download that is the whole file pre-allocated in zeros,
// the disk fills up, and the transfer looks stuck. markSparse is what turns
// the gaps into holes; if it ever stops working this test goes red before a
// user loses their disk again.
func TestSparseGapsCostNothing(t *testing.T) {
	const (
		size    = 64 << 20 // 64 MiB logical
		writeAt = 32 << 20 // one 64 KiB chunk in the middle
	)

	plain, err := os.CreateTemp(t.TempDir(), "plain-*.bin")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer plain.Close()
	if err := plain.Truncate(size); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if _, err := plain.WriteAt(make([]byte, 64<<10), writeAt); err != nil {
		t.Fatalf("write: %v", err)
	}
	plainAlloc := allocatedBytes(t, plain)

	sparse, err := os.CreateTemp(t.TempDir(), "sparse-*.bin")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer sparse.Close()
	if err := markSparse(sparse); err != nil {
		t.Skipf("this filesystem has no sparse files: %v", err)
	}
	if err := sparse.Truncate(size); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if _, err := sparse.WriteAt(make([]byte, 64<<10), writeAt); err != nil {
		t.Fatalf("write: %v", err)
	}
	sparseAlloc := allocatedBytes(t, sparse)

	// The control proves the measurement can see the problem at all: a
	// non-sparse 64 MiB file with one chunk in the middle occupies ~64 MiB.
	if plainAlloc < size/2 {
		t.Fatalf("control file only allocated %d bytes of %d - the measurement is wrong", plainAlloc, int64(size))
	}
	if sparseAlloc > 8<<20 {
		t.Fatalf("sparse file allocated %.1f MiB for one 64 KiB write - gaps are being zero-filled again",
			float64(sparseAlloc)/(1<<20))
	}
}
