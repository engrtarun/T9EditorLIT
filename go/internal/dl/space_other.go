//go:build !windows

package dl

import "errors"

// The daemon ships as a Windows executable. This stub exists so the package
// still builds on a CI runner that only type-checks it, and it says "unknown"
// instead of inventing a number.
func freeSpaceAt(string) (int64, error) {
	return 0, errors.New("disk free space is not implemented on this platform")
}
