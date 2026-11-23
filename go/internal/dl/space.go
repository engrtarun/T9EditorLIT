package dl

import (
	"fmt"
	"sync"
	"time"
)

// freeSpaceCache keeps GetDiskFreeSpaceEx out of the panel's 800 ms poll.
// The number only moves when a file is written, so one sample a second is
// plenty — and the panel asks once per row, so an uncached call would be a
// syscall per row per poll.
var (
	freeMu    sync.Mutex
	freeAt    time.Time
	freeDir   string
	freeValue int64
	freeKnown bool
)

// diskFree reports the bytes a download into `dir` can still use.
//
// ok=false means "this platform cannot tell us". The UI must then say nothing
// rather than guess: a made-up storage number is worse than no number.
func diskFree(dir string) (int64, bool) {
	freeMu.Lock()
	defer freeMu.Unlock()
	if freeKnown && dir == freeDir && time.Since(freeAt) < time.Second {
		return freeValue, true
	}
	n, err := freeSpaceAt(dir)
	freeAt, freeDir = time.Now(), dir
	if err != nil {
		freeKnown = false
		return 0, false
	}
	freeValue, freeKnown = n, true
	return n, true
}

// humanBytes is the one size sentence the daemon says out loud: "21.3 GB".
// It is deliberately decimal-free (1024-based) and one decimal place, the
// same shape the panel prints, so a refusal and the bar never disagree.
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
