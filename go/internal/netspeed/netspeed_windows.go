//go:build windows

package netspeed

import (
	"net"
	"syscall"
)

// tunedDialer raises the socket receive buffer on Windows. Larger receive
// buffers let the kernel absorb bursts without stalling the sender.
func tunedDialer() *net.Dialer {
	d := &net.Dialer{}
	d.Control = func(network, address string, c syscall.RawConn) error {
		return c.Control(func(fd uintptr) {
			_ = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4<<20)
			_ = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, 256<<10)
		})
	}
	return d
}
