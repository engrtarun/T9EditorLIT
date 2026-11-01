//go:build !windows

package dl

import "os"

// markSparse is a no-op outside Windows: ftruncate(2) already produces a file
// with holes on ext4, APFS and every other filesystem the daemon runs on, so
// writing at an offset costs only the bytes that are actually written.
func markSparse(*os.File) error { return nil }
