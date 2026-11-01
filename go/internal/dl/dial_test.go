package dl

import (
	"net"
	"testing"
)

// TestOrderIPv4First is the 21 MB/s download that died at 98 MB: fifteen
// sockets on IPv4 were healthy and the sixteenth hung on a blackholed IPv6
// address. Ordering A records first means that socket gets a working address
// immediately, and a v6-only host is still reachable at the end of the list.
func TestOrderIPv4First(t *testing.T) {
	v6a := net.ParseIP("2001:41d0:242:d300::")
	v6b := net.ParseIP("2a00:1450:4001:80f::200e")
	v4a := net.ParseIP("51.91.236.193")
	v4b := net.ParseIP("1.1.1.1")

	got := orderIPv4First([]net.IPAddr{{IP: v6a}, {IP: v4a}, {IP: v6b}, {IP: v4b}})
	want := []net.IP{v4a, v4b, v6a, v6b}
	if len(got) != len(want) {
		t.Fatalf("want %d addresses, got %d", len(want), len(got))
	}
	for i := range want {
		if !got[i].IP.Equal(want[i]) {
			t.Fatalf("address %d: want %s, got %s", i, want[i], got[i].IP)
		}
	}

	// Nothing may be lost: a v6-only host must keep its address.
	only6 := orderIPv4First([]net.IPAddr{{IP: v6a}, {IP: v6b}})
	if len(only6) != 2 || !only6[0].IP.Equal(v6a) {
		t.Fatalf("a v6-only host must keep its addresses in order, got %v", only6)
	}
}
