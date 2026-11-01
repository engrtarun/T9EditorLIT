//go:build windows

package dl

import (
	"os"

	"golang.org/x/sys/windows"
)

// fsctlSetSparse is FSCTL_SET_SPARSE: CTL_CODE(FILE_DEVICE_FILE_SYSTEM=9,
// 49, METHOD_BUFFERED=0, FILE_SPECIAL_ACCESS=0) = 0x900C4.
const fsctlSetSparse = 0x000900C4

// markSparse lets the partial file contain holes on NTFS.
//
// This is not an optimisation, it is a correctness fix for multi-segment
// downloads on Windows. A non-sparse file cannot have unwritten gaps: the
// first WriteAt past the current valid data length makes the filesystem
// zero-fill and allocate every byte in between. With twelve segments the
// second worker writes at ~1/12th of a 45 GB file, so Windows allocates
// ~3.7 GB of zeros before a single network byte lands there — and each later
// worker does the same, until the whole file is a pre-zeroed block. The disk
// fills with zeros, the writes compete with the real payload, and the download
// looks stuck or slow while it is actually busy writing nothing.
//
// A sparse file turns those gaps into holes: only the bytes that really
// arrived occupy clusters, and a 90 GB download can start and make progress on
// a disk that does not have 90 GB free yet.
func markSparse(f *os.File) error {
	h := windows.Handle(f.Fd())
	var returned uint32
	return windows.DeviceIoControl(h, fsctlSetSparse, nil, 0, nil, 0, &returned, nil)
}
