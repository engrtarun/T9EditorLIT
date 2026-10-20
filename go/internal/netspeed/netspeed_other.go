//go:build !windows

package netspeed

import "net"

// tunedDialer is a no-op on non-Windows platforms; the receive-buffer tuning
// is Windows-specific. Parallelism and larger read buffers still apply.
func tunedDialer() *net.Dialer {
	return &net.Dialer{}
}
