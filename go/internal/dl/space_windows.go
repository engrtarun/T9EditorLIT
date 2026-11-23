//go:build windows

package dl

import (
	"syscall"
	"unsafe"
)

var (
	diskModKernel32             = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceExW = diskModKernel32.NewProc("GetDiskFreeSpaceExW")
)

// freeSpaceAt is GetDiskFreeSpaceExW's "free bytes available to the calling
// user" — the number a download can actually spend. It is deliberately not
// the volume's total free space: a quota or a per-user limit would make that
// one a lie.
func freeSpaceAt(dir string) (int64, error) {
	p, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return 0, err
	}
	var freeAvail, total, totalFree uint64
	r, _, callErr := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeAvail)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if r == 0 {
		return 0, callErr
	}
	return int64(freeAvail), nil
}
