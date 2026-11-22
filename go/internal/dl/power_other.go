//go:build !windows

package dl

// acquireWakeLock is a no-op outside Windows. The daemon ships on Windows;
// this file exists so the package still builds and tests on CI runners of
// every OS.
func acquireWakeLock() func() { return func() {} }
