// Package netspeed measures real download throughput for the "honesty meter".
//
// Why this lives in Go instead of the webview:
//
//   - The webview's fetch() is single-socket and serialised through the
//     browser's network stack; on a fast link one socket cannot fill the pipe
//     and the reading shows a fraction of the real speed (the old frontend
//     code reported ~2 MB/s on a 40 Mbps line for exactly this reason).
//   - Go gives us parallel connections, larger read buffers and socket-level
//     receive-buffer tuning (SO_RCVBUF) that the webview does not expose.
//   - The daemon is already the single place that owns network access for the
//     app (Groq, Gemini, Telegram), so routing the speed probe through it
//     keeps "all network goes through Go" true instead of leaving one stray
//     fetch() in the UI.
//
// The measurement streams every byte straight to io.Discard: nothing of the
// downloaded payload is ever buffered in RAM, which matters on the 8 GB
// target box. Only a small fixed read buffer (256 KiB) is held per socket.
package netspeed

import (
	"bufio"
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// Result is the shape the frontend expects. JSON tags are fixed to match the
// TypeScript `measureNetworkSpeed` return value, so swapping the implementation
// is invisible to the UI.
type Result struct {
	MBPS            float64 `json:"mbps"`
	MegabytesPerSec float64 `json:"megabytesPerSec"`
}

// Options tune a single measurement. Zero values get sane defaults.
type Options struct {
	// Window is how long to keep downloading. Defaults to 3s.
	Window time.Duration
	// Conns is the number of parallel connections. Defaults to 4.
	Conns int
	// Endpoint overrides the download URL. Defaults to Cloudflare's speed test.
	Endpoint string
	// ReadBuf is the per-socket read buffer. Defaults to 256 KiB.
	ReadBuf int
}

const (
	defaultWindow   = 3 * time.Second
	defaultConns    = 4
	defaultReadBuf  = 256 * 1024
	defaultEndpoint = "https://speed.cloudflare.com/__down?bytes=8000000"
)

// Measure runs the probe and returns throughput. It blocks until the window
// elapses (plus a small grace period for in-flight reads to finish).
func Measure(ctx context.Context, opts Options) (Result, error) {
	if opts.Window <= 0 {
		opts.Window = defaultWindow
	}
	if opts.Conns <= 0 {
		opts.Conns = defaultConns
	}
	if opts.ReadBuf <= 0 {
		opts.ReadBuf = defaultReadBuf
	}
	if opts.Endpoint == "" {
		opts.Endpoint = defaultEndpoint
	}

	// Clamp to sane bounds so a bad query string cannot pin the daemon.
	if opts.Window < 500*time.Millisecond {
		opts.Window = 500 * time.Millisecond
	}
	if opts.Window > 15*time.Second {
		opts.Window = 15 * time.Second
	}
	if opts.Conns < 1 {
		opts.Conns = 1
	}
	if opts.Conns > 16 {
		opts.Conns = 16
	}

	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           tunedDialer().DialContext,
		MaxIdleConns:          opts.Conns * 2,
		MaxConnsPerHost:       0,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true,
		ResponseHeaderTimeout: 10 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
	}
	client := &http.Client{Transport: transport}

	// The measurement window. A grace deadline lets in-flight reads drain
	// instead of being cut mid-syscall.
	start := time.Now()
	deadline := start.Add(opts.Window)
	grace := deadline.Add(5 * time.Second)
	ctx, cancel := context.WithDeadline(ctx, grace)
	defer cancel()

	var total atomic.Int64
	var wg sync.WaitGroup

	for i := 0; i < opts.Conns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			buf := make([]byte, opts.ReadBuf)
			for time.Now().Before(deadline) {
				if ctx.Err() != nil {
					return
				}
				req, err := http.NewRequestWithContext(ctx, http.MethodGet, opts.Endpoint, nil)
				if err != nil {
					return
				}
				req.Header.Set("Accept-Encoding", "identity")
				resp, err := client.Do(req)
				if err != nil {
					if ctx.Err() != nil {
						return
					}
					time.Sleep(100 * time.Millisecond)
					continue
				}
				// Stream to discard. Read manually so we can honour the
				// deadline between reads and use the larger buffer we tuned.
				br := bufio.NewReaderSize(resp.Body, opts.ReadBuf)
				for {
					if time.Now().After(deadline) {
						resp.Body.Close()
						return
					}
					n, rerr := br.Read(buf)
					if n > 0 {
						total.Add(int64(n))
					}
					if rerr != nil {
						break
					}
				}
				resp.Body.Close()
			}
		}()
	}

	wg.Wait()
	transport.CloseIdleConnections()

	// Denominator is the fixed measurement window, not the (variable) wall
	// time: this is what makes one slow burst unable to skew the number, and
	// it matches the documented "keeps fetching for a fixed window" contract.
	elapsed := opts.Window.Seconds()
	if elapsed <= 0 {
		return Result{}, errors.New("no elapsed time")
	}
	bytes := total.Load()
	if bytes <= 0 {
		return Result{}, errors.New("no bytes received")
	}
	mbs := float64(bytes) / 1_048_576 / elapsed
	return Result{MBPS: mbs * 8, MegabytesPerSec: mbs}, nil
}
