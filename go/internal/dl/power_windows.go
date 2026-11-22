//go:build windows

package dl

import (
	"runtime"
	"syscall"
)

// Windows' SetThreadExecutionState flags. ES_CONTINUOUS makes the request
// sticky for the calling thread; ES_SYSTEM_REQUIRED keeps the machine awake
// (the display may still switch off, which is what a laptop user expects).
const (
	esContinuous     = 0x8000_0000
	esSystemRequired = 0x0000_0001
)

var (
	kernel32                = syscall.NewLazyDLL("kernel32.dll")
	setThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
)

func setExecutionState(flags uintptr) {
	_, _, _ = setThreadExecutionState.Call(flags)
}

// acquireWakeLock keeps the system awake until the returned release is called.
//
// The request is per-thread, so a dedicated OS thread owns it: a goroutine that
// migrates between threads would leave ES_CONTINUOUS set on a thread nobody can
// clear. Each running download gets its own thread; the last release clears the
// request and lets Windows sleep again.
func acquireWakeLock() func() {
	done := make(chan struct{})
	ready := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		setExecutionState(esContinuous | esSystemRequired)
		close(ready)
		<-done
		setExecutionState(esContinuous)
	}()
	<-ready
	return func() { close(done) }
}
