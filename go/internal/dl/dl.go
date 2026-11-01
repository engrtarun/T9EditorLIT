// Package dl is the fast multi-segment downloader behind the in-built
// browser's download button.
//
// The 1DM trick: one file is fetched with several parallel HTTP Range
// connections instead of one. A single socket cannot fill a fast pipe —
// latency × window size caps it — while eight sockets on the same file
// routinely multiply the throughput several times over. The daemon is the
// right owner for this work: it already holds the app's network access, it
// outlives the window, and it never buffers the payload — every 64 KiB read
// goes straight to disk with WriteAt, so a 5 GB file costs 512 KiB of RAM
// with eight segments in flight (the AGENTS.md zero-RAM rule).
//
// State that must survive a pause, a crash or a daemon restart lives in a
// `<file>.part.json` sidecar next to the partial file: the URL, the server's
// ETag, and each segment's byte offset. Resume re-issues Range requests from
// exactly where the writers stopped; if the ETag changed the file is
// different now and the resume is refused rather than corrupted.
package dl

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The statuses the UI mirrors. Terminal ones stop the poller's timer.
const (
	StatusRunning   = "running"
	StatusPaused    = "paused"
	StatusDone      = "done"
	StatusError     = "error"
	StatusCancelled = "cancelled"
)

const (
	// DefaultSegments is the parallel connection count for a range-capable
	// file. Eight is the sweet spot on a consumer link: beyond ~16 the gains
	// flatten and some servers start refusing.
	DefaultSegments = 8

	// DefaultMinSegmentBytes is the size below which splitting is a loss:
	// the setup round-trips cost more than the parallelism gains.
	DefaultMinSegmentBytes = 8 << 20 // 8 MiB

	// BufferBytes is one segment's read buffer. The pool reuses them, so the
	// steady-state cost is segments × 64 KiB per download.
	BufferBytes = 64 << 10

	// MaxRetries is no longer a budget the download dies on: a transient
	// failure keeps retrying (that is what a multi-hour transfer needs), and
	// only a permanent refusal or the stall watchdog ends the row. It remains
	// the reference point tests use for "more than a handful of blips".
	MaxRetries = 5

	// IdleTimeout drops a server that sends nothing for this long instead
	// of hanging the row at "0% 0.0 MB" forever — file hosts stall mid-
	// transfer constantly (the 45 GB Lucifer paste that never moved one
	// byte). The reconnect resumes from the exact offset on disk, so
	// nothing is ever re-fetched twice.
	IdleTimeout = 30 * time.Second

	// ResponseHeaderTimeout bounds the wait for a server's first answer.
	// There is no overall client timeout (huge files take hours), so this
	// is what stops a silent host from hanging Do() indefinitely.
	ResponseHeaderTimeout = 15 * time.Second

	// HugeBytes is the size past which extra parallel connections still
	// pay off: 45–90 GB over the default eight sockets leaves real
	// throughput on the table, so huge files get more.
	HugeBytes    = 1 << 30 // 1 GiB
	HugeSegments = 16

	// HardMaxSegments is the ceiling; some hosts refuse or throttle above
	// a dozen connections on one file. Measured on this machine (1 GB test
	// file, 15 s windows): 1 conn = 6 MB/s, 8 = 14 MB/s, 16 = 17-19 MB/s,
	// 24 = 17 MB/s - sixteen is where the curve flattens.
	HardMaxSegments = 16

	// keepTerminalFor is how long a finished row stays in the list before
	// List() drops it, so a long-running daemon cannot grow the queue
	// forever.
	keepTerminalFor = 15 * time.Minute

	// maxItems bounds the list; the oldest terminal rows go first.
	maxItems = 50
)

// ErrNotFound is returned when an id is not in the queue.
var ErrNotFound = errors.New("no such download")

// ErrBusy is returned when an action does not fit the item's status (pause
// on a finished download, resume on a running one, ...).
var ErrBusy = errors.New("that download is not in a state where that works")

// Item is one row of the queue — exactly the shape the frontend's
// `DownloadItem` mirrors, down to the camelCase tags. The bytes are counted
// here; the UI only draws what it reads.
type Item struct {
	ID            string `json:"id"`
	URL           string `json:"url"`
	Filename      string `json:"filename"`
	Path          string `json:"path"`
	TotalBytes    int64  `json:"totalBytes"`
	ReceivedBytes int64  `json:"receivedBytes"`
	SpeedBps      int64  `json:"speedBps"`
	Segments      int    `json:"segments"`
	Status        string `json:"status"`
	Error         string `json:"error,omitempty"`
}

// Options configure a Manager. Zero values get the defaults above.
type Options struct {
	// Dir is the destination folder. Empty means the user's Downloads
	// folder.
	Dir string
	// Log receives the download lifecycle lines.
	Log *slog.Logger
	// Segments overrides the parallel connection count (tests use 4).
	Segments int
	// MinSegmentBytes overrides the splitting threshold (tests use 64 KiB).
	MinSegmentBytes int64
	// Client is injected by tests; nil builds the default one.
	Client *http.Client
}

// Manager owns the queue. It is safe for concurrent use.
type Manager struct {
	dir             string
	segments        int
	minSegmentBytes int64
	client          *http.Client
	log             *slog.Logger

	mu    sync.Mutex
	items map[string]*download
}

// New builds a manager and makes sure the destination folder exists.
func New(opts Options) (*Manager, error) {
	dir := opts.Dir
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("cannot locate the Downloads folder: %w", err)
		}
		dir = filepath.Join(home, "Downloads")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("cannot create the download folder: %w", err)
	}

	log := opts.Log
	if log == nil {
		log = slog.Default()
	}
	segs := opts.Segments
	if segs <= 0 {
		segs = DefaultSegments
	}
	minSeg := opts.MinSegmentBytes
	if minSeg <= 0 {
		minSeg = DefaultMinSegmentBytes
	}
	client := opts.Client
	if client == nil {
		client = &http.Client{
			// No global Timeout: a 5 GB file legitimately takes hours. The
			// dial and TLS handshakes still time out, so a dead host fails
			// in seconds instead of hanging a row forever.
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				DialContext:           preferIPv4,
				TLSHandshakeTimeout:   10 * time.Second,
				MaxIdleConnsPerHost:   HardMaxSegments + 2,
				ResponseHeaderTimeout: ResponseHeaderTimeout,
			},
		}
	}

	m := &Manager{
		dir:             dir,
		segments:        segs,
		minSegmentBytes: minSeg,
		client:          client,
		log:             log,
		items:           map[string]*download{},
	}
	// A daemon restart must not look like "my download never started": the
	// `.part.json` sidecars on disk are the queue's memory, and every one of
	// them becomes a paused row the user can resume.
	m.recoverPartials()
	return m, nil
}

// recoverPartials adopts the sidecars a previous daemon left behind.
//
// It runs once, at startup, before anything is listening: the list the UI
// polls then shows the interrupted downloads instead of an empty panel, which
// is what made a 45 GB transfer look like it had never begun. A sidecar whose
// segments are all complete but whose rename never happened (Windows can hold
// a freshly written file for a moment) is finished right here.
func (m *Manager) recoverPartials() {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".part.json") {
			continue
		}
		sidePath := filepath.Join(m.dir, e.Name())
		b, err := os.ReadFile(sidePath)
		if err != nil {
			continue
		}
		var sc sidecar
		if json.Unmarshal(b, &sc) != nil || sc.Version != 1 || sc.TotalBytes <= 0 {
			continue
		}
		partPath := strings.TrimSuffix(sidePath, ".json")
		st, err := os.Stat(partPath)
		if err != nil {
			_ = os.Remove(sidePath) // a sidecar without its partial is litter
			continue
		}
		if st.Size() < sc.TotalBytes {
			_ = os.Truncate(partPath, sc.TotalBytes)
		}

		filename := sc.Filename
		if filename == "" {
			filename = strings.TrimSuffix(filepath.Base(partPath), ".part")
		}
		d := &download{
			id:           newID(),
			url:          sc.URL,
			referer:      sc.Referer,
			filename:     filename,
			partPath:     partPath,
			sidePath:     sidePath,
			totalBytes:   sc.TotalBytes,
			ranged:       sc.Ranged,
			etag:         sc.ETag,
			lastModified: sc.LastModified,
			status:       StatusPaused,
			client:       m.client,
			log:          m.log,
		}
		var got int64
		for _, s := range sc.Segments {
			seg := &segment{start: s.Start, end: s.End}
			if s.Done > 0 && s.Done <= seg.length() {
				seg.done.Store(s.Done)
				got += s.Done
			}
			d.segs = append(d.segs, seg)
		}
		if len(d.segs) == 0 {
			continue
		}
		d.received.Store(got)

		if got >= d.totalBytes && d.totalBytes > 0 {
			// Every byte is on disk; only the last step is missing.
			d.status = StatusRunning
			d.finishLocked()
			d.log.Info("finished an interrupted download at startup",
				"path", partPath, "status", d.status)
		} else {
			d.log.Info("recovered an unfinished download",
				"path", partPath, "have", got, "total", d.totalBytes)
			diagf("recover id=%s file=%s at=%d/%d", d.id, d.filename, got, d.totalBytes)
		}
		m.items[d.id] = d
	}
}

// Dir is the destination folder downloads land in.
func (m *Manager) Dir() string { return m.dir }

// Start probes the URL and begins downloading it.
//
// The probe is synchronous — one round trip that learns the size, the range
// support and the real filename — so the caller gets a complete Item back
// (or a clear error) instead of a row that fails a second later.
func (m *Manager) Start(rawURL, referer string) (*Item, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, errors.New("sirf http/https URL chalega")
	}

	// Same link, same queue: a recovered or paused row *is* the download the
	// user means. Starting it again resumes it instead of writing a second
	// partial file next to the first (which is how three 46 GB `.part` files
	// ended up in Downloads) - and it needs no probe, so a flaky host cannot
	// refuse a resume it has already agreed to once.
	if existing := m.runningOrPaused(rawURL); existing != nil {
		if existing.status == StatusPaused {
			_ = existing.resume()
		}
		item := existing.snapshot()
		return &item, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	probe, err := m.probeRetry(ctx, rawURL, referer)
	if err != nil {
		diagf("probe fail %s err=%v", parsed.Host, err)
		return nil, err
	}

	// The filename prefers the server's Content-Disposition (that is what a
	// browser shows), then the URL path, then a fixed name.
	name := probe.filename
	if name == "" {
		name = path.Base(parsed.Path)
	}
	name = sanitizeFilename(name)

	// A previous attempt at the same file leaves a `.part` plus its sidecar on
	// disk, and those bytes are real: resuming them is the difference between a
	// 45 GB download taking hours once and taking hours every single time. The
	// sidecar is only trusted when it describes the same URL, the same size and
	// (when both sides know it) the same ETag - a changed ETag means the file
	// behind the URL is a different file, and splicing them would corrupt both.
	resume, dest := m.resumable(rawURL, probe)
	if dest == "" {
		dest = m.reservePath(name)
	}

	d := &download{
		id:           newID(),
		url:          rawURL,
		referer:      referer,
		filename:     filepath.Base(dest),
		partPath:     dest + ".part",
		sidePath:     dest + ".part.json",
		totalBytes:   probe.total,
		ranged:       probe.ranged,
		etag:         probe.etag,
		lastModified: probe.lastModified,
		ua:           probe.ua,
		status:       StatusRunning,
		client:       m.client,
		log:          m.log,
	}

	// One segment when the server cannot range, when the size is unknown, or
	// when the file is too small for splitting to pay off.
	n := m.segments
	if !probe.ranged || probe.total <= 0 || probe.total < m.minSegmentBytes {
		n = 1
	}
	// Huge files pay for more sockets than the default: past ~1 GiB the
	// per-connection setup is noise against hours of transfer, and eight
	// sockets leave real throughput on the table.
	if probe.total >= HugeBytes && n > 1 && n < HugeSegments {
		n = HugeSegments
	}
	if n > HardMaxSegments {
		n = HardMaxSegments
	}
	// Each segment must hold its own worth: below ~64 KiB the per-connection
	// round trips cost more than the parallelism returns. The floor scales
	// with the configured threshold so tests (64 KiB total) still split.
	floor := m.minSegmentBytes / int64(m.segments)
	if floor < 64<<10 {
		floor = 64 << 10
	}
	for n > 1 && probe.total/int64(n) < floor {
		n /= 2
	}
	d.segs = splitSegments(probe.total, n, probe.ranged)
	if resume != nil {
		// The sidecar's offsets are only usable when the split is identical;
		// `adoptSidecar` checks that and reports how many bytes it recovered.
		if got := d.adoptSidecar(resume); got > 0 {
			diagf("resume id=%s file=%s at=%d", d.id, d.filename, got)
		}
	}
	diagf("start %s id=%s total=%d ranged=%v segs=%d",
		parsed.Host, d.id, probe.total, probe.ranged, len(d.segs))

	if err := d.open(); err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.items[d.id] = d
	m.pruneLocked()
	m.mu.Unlock()

	go d.run()

	item := d.snapshot()
	m.log.Info("download started",
		"url", rawURL, "id", d.id, "bytes", probe.total, "segments", len(d.segs))
	return &item, nil
}

// probeResult is what one round trip learned about the file.
type probeResult struct {
	total        int64
	ranged       bool
	filename     string
	etag         string
	lastModified string
	// ua is the identity the probe was answered under; the transfer keeps it,
	// because a host that agreed under `curl/` will not answer a browser UA
	// mid-download either.
	ua string
}

// The two identities a request can carry.
//
// uaBrowser is the default: an in-app browser download should look like one,
// and real file hosts (Google's CDN among them) refuse a bare `Go-http-client`
// UA. uaPlain is the fallback for the hosts that do the opposite - measured on
// a public speed server: Chrome-UA requests were dropped on the socket 3 out
// of 3 times while curl's UA was answered 3 out of 3 - and it is only ever
// tried after the browser UA has failed.
const (
	uaBrowser = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"
	uaPlain   = "curl/8.5.0"
)

// userAgent is empty on a row recovered from a sidecar, which never saw a
// server: it starts as the browser and downgrades only if the host refuses it.
func userAgent(ua string) string {
	if ua == "" {
		return uaBrowser
	}
	return ua
}

// dialTimeout bounds one TCP connect. A host on the other side of the world
// that has not answered a SYN in six seconds is not going to answer the
// segment either, and 16 segments each waiting the full ten is how a healthy
// file spends two minutes looking dead.
const dialTimeout = 6 * time.Second

// preferIPv4 dials the IPv4 addresses first.
//
// Measured on this box against a 1 GB host: fifteen sockets ran at 21 MB/s
// over IPv4 while the sixteenth hung on a blackholed IPv6 address until the
// dial timeout and failed the whole row. Go's dual-stack fallback only helps
// when the first answer fails fast; a route that silently swallows packets is
// neither fast nor an error, so the family order has to come first. A v4-only
// network loses nothing, and a v6-only host still gets its addresses.
func preferIPv4(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	// A literal address (or a unix socket) has nothing to order.
	if err != nil || net.ParseIP(host) != nil || strings.HasSuffix(network, "6") {
		d := net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, network, addr)
	}

	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		d := net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
		return d.DialContext(ctx, network, addr)
	}

	var lastErr error
	tried := 0
	for _, a := range orderIPv4First(ips) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		d := net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
		c, err := d.DialContext(ctx, network, net.JoinHostPort(a.IP.String(), port))
		if err == nil {
			return c, nil
		}
		lastErr = err
		if tried++; tried >= 6 {
			break
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no address for %s", host)
	}
	return nil, lastErr
}

// orderIPv4First sorts A records ahead of AAAA, keeping the resolver's order
// inside each family.
func orderIPv4First(ips []net.IPAddr) []net.IPAddr {
	out := make([]net.IPAddr, 0, len(ips))
	for _, a := range ips {
		if a.IP.To4() != nil {
			out = append(out, a)
		}
	}
	for _, a := range ips {
		if a.IP.To4() == nil {
			out = append(out, a)
		}
	}
	return out
}

// probeRetry asks twice more before giving up.
//
// One dropped connection used to be the whole answer: HEAD, then the Range
// question and then the plain GET all failed with `EOF`, and the user was
// told "the server refuses to give the file" for a host that was merely
// busy (a speed-test server rate-limiting us right after a benchmark, a CDN
// recycling an idle socket). "90 GB file start hi nahi hui" was often this
// one line of code. An error page is different - retrying a link that has
// gone bad cannot help - so that one fails immediately.
func (m *Manager) probeRetry(ctx context.Context, rawURL, referer string) (*probeResult, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			diagf("probe retry %d err=%v", attempt, lastErr)
			time.Sleep(time.Duration(attempt) * 700 * time.Millisecond)
		}
		actx, cancel := context.WithTimeout(ctx, 60*time.Second)
		res, err := m.probe(actx, rawURL, referer, uaBrowser)
		cancel()
		if err == nil {
			return res, nil
		}
		lastErr = err
		if errors.Is(err, errHTMLPage) {
			return nil, err
		}
	}

	// The last question, under a different name: a host that closes the
	// socket the moment it sees a browser User-Agent looks exactly like a
	// dead link, and `curl`'s own UA answers it (measured: one popular speed
	// server dropped Chrome-UA requests three times out of three while
	// answering curl's three times out of three). Real file hosts want the
	// browser UA, so that one is always tried first; this is the fallback.
	actx, cancel := context.WithTimeout(ctx, 60*time.Second)
	res, err := m.probe(actx, rawURL, referer, uaPlain)
	cancel()
	if err == nil {
		diagf("probe fallback ua=plain ok host=%s", rawURL)
		return res, nil
	}
	return nil, lastErr
}

// probe asks the server what it is about to serve.
//
// HEAD first — it is cheap and most servers answer it. A server that refuses
// HEAD (405, or a CDN that treats it differently) falls back to a one-byte
// ranged GET, which is the more honest question anyway: a 206 answer proves
// range support regardless of what any header claims.
func (m *Manager) probe(ctx context.Context, rawURL, referer, ua string) (*probeResult, error) {
	head, err := m.newRequest(ctx, http.MethodHead, rawURL, referer, ua)
	if err != nil {
		return nil, err
	}
	var lastErr error
	if resp, err := m.client.Do(head); err == nil {
		io.Copy(io.Discard, resp.Body) // drain, so the connection can be reused
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if isHTML(resp.Header.Get("Content-Type")) {
				return nil, errHTMLPage
			}
			res := &probeResult{
				total:        resp.ContentLength,
				ranged:       strings.EqualFold(resp.Header.Get("Accept-Ranges"), "bytes"),
				filename:     filenameFromDisposition(resp.Header.Get("Content-Disposition")),
				etag:         resp.Header.Get("ETag"),
				lastModified: resp.Header.Get("Last-Modified"),
				ua:           ua,
			}
			// Accept-Ranges missing is not proof of no support — ask with a
			// real Range request before giving up on splitting. A chunked HEAD
			// (no Content-Length) is the other reason to ask: the range answer
			// carries the size in Content-Range.
			if !res.ranged || res.total <= 0 {
				if ranged, total := m.probeRange(ctx, rawURL, referer, ua); ranged {
					res.ranged = true
					if total > 0 {
						res.total = total
					}
				}
			}
			return res, nil
		}
		lastErr = fmt.Errorf("HEAD ne status %d diya", resp.StatusCode)
	} else {
		lastErr = err
	}

	// HEAD failed outright — the one-byte GET is the next question.
	if ranged, total := m.probeRange(ctx, rawURL, referer, ua); ranged {
		return &probeResult{total: total, ranged: true, ua: ua}, nil
	}
	// Last resort: some file hosts refuse HEAD *and* ignore Range. A plain GET
	// still starts the download (one connection, unknown length), which beats
	// refusing to start a 90 GB file at all.
	if res, err := m.probeGet(ctx, rawURL, referer, ua); err == nil {
		return res, nil
	} else if err != nil {
		lastErr = err
	}
	return nil, fmt.Errorf("server ne file dene se mana kar diya (%v)", lastErr)
}

// errHTMLPage is the honest answer when a "download" URL serves a web page:
// an expired link, a captcha or an error page looks like a file to a URL
// parser and exactly like garbage inside a 45 GB `.part` to the user.
var errHTMLPage = errors.New("link ek web page kholta hai, file nahi - page pe download button dabao")

func isHTML(contentType string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "text/html")
}

// rateLimitError is a host saying "too many connections from you right now"
// (429, 408, 503). It is not a failure - reconnecting harder on the next
// attempt turns a hiccup into a ban, so fetchSegment waits like the server
// asked before trying again.
type rateLimitError struct {
	status int
	wait   time.Duration // from Retry-After, when the server sent one
}

func (e *rateLimitError) Error() string {
	if e.wait > 0 {
		return fmt.Sprintf("server ne speed thamne ko kaha (status %d, %ds rukna)", e.status, int(e.wait.Seconds()))
	}
	return fmt.Sprintf("server ne speed thamne ko kaha (status %d)", e.status)
}

// rateLimitBase is how long to wait after a 429 with no Retry-After header,
// and then how fast to grow it. It is a variable so tests do not sleep for
// real seconds.
var rateLimitBase = 8 * time.Second

// retryBase is the first backoff for an ordinary broken connection; each
// attempt doubles it. A variable for the same reason as rateLimitBase.
var retryBase = 300 * time.Millisecond

// isRateLimited: the three answers that mean "slow down, not never".
func isRateLimited(status int) bool {
	return status == http.StatusTooManyRequests ||
		status == http.StatusRequestTimeout ||
		status == http.StatusServiceUnavailable
}

// statusError is a refusal that retrying cannot fix: an expired link (404,
// 410), a login wall (401, 403) or a body this client cannot range. It is
// kept apart from timeouts and EOFs because those are the normal weather of a
// multi-hour transfer, and retrying those is the whole point.
type statusError struct{ status int }

func (e *statusError) Error() string {
	return fmt.Sprintf("server ne mana kar diya (status %d)", e.status)
}

// permanent reports whether an error is a real answer rather than a hiccup.
func permanent(err error) bool {
	var se *statusError
	if errors.As(err, &se) {
		return se.status >= 400 && se.status < 500 && !isRateLimited(se.status)
	}
	return false
}

// retryAfter reads the RFC 7231 delay in seconds. An HTTP-date is allowed by
// the spec but almost never sent for a download link, and mis-reading it as
// zero is exactly the exponential backoff we wanted anyway.
func retryAfter(v string) time.Duration {
	v = strings.TrimSpace(v)
	if v == "" {
		return 0
	}
	secs, err := strconv.Atoi(v)
	if err != nil || secs < 0 {
		return 0
	}
	if secs > 120 {
		secs = 120
	}
	return time.Duration(secs) * time.Second
}

// probeGet is the last-resort probe: a plain GET whose body is dropped after a
// few kilobytes. It learns the size and the filename when the server supports
// neither HEAD nor Range, and turns an HTML error page into a real message.
func (m *Manager) probeGet(ctx context.Context, rawURL, referer, ua string) (*probeResult, error) {
	req, err := m.newRequest(ctx, http.MethodGet, rawURL, referer, ua)
	if err != nil {
		return nil, err
	}
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("GET ne status %d diya", resp.StatusCode)
	}
	if isHTML(resp.Header.Get("Content-Type")) {
		return nil, errHTMLPage
	}
	_, _ = io.CopyN(io.Discard, resp.Body, 32<<10)
	return &probeResult{
		total:        resp.ContentLength,
		filename:     filenameFromDisposition(resp.Header.Get("Content-Disposition")),
		etag:         resp.Header.Get("ETag"),
		lastModified: resp.Header.Get("Last-Modified"),
		ua:           ua,
	}, nil
}

// probeRange sends `Range: bytes=0-0`. A 206 answers with the full size in
// Content-Range (`bytes 0-0/12345`) and proves range support in one shot.
func (m *Manager) probeRange(ctx context.Context, rawURL, referer, ua string) (bool, int64) {
	req, err := m.newRequest(ctx, http.MethodGet, rawURL, referer, ua)
	if err != nil {
		return false, 0
	}
	req.Header.Set("Range", "bytes=0-0")
	resp, err := m.client.Do(req)
	if err != nil {
		return false, 0
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		return false, 0
	}
	_, _ = io.CopyN(io.Discard, resp.Body, 1)
	return true, parseContentRangeTotal(resp.Header.Get("Content-Range"))
}

func (m *Manager) newRequest(ctx context.Context, method, rawURL, referer, ua string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	// Downloading from inside the app's browser should look like it: some
	// hosts (YouTube's CDN among them) refuse a bare request with no referrer.
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	req.Header.Set("User-Agent", userAgent(ua))
	// Raw bytes, always. Without this Go transparently asks for gzip and
	// decompresses on the fly, so Content-Length stops matching the bytes we
	// write and a "45 GB" file arrives short.
	req.Header.Set("Accept-Encoding", "identity")
	return req, nil
}

// reservePath returns a free destination path: the wanted name, or
// "name (1).ext", "name (2).ext", ... when something already sits there.
func (m *Manager) reservePath(name string) string {
	m.mu.Lock()
	taken := make(map[string]bool, len(m.items))
	for _, d := range m.items {
		taken[d.partPath] = true
		taken[strings.TrimSuffix(d.partPath, ".part")] = true
	}
	m.mu.Unlock()

	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for i := 0; ; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s (%d)%s", stem, i, ext)
		}
		full := filepath.Join(m.dir, candidate)
		if taken[full] || taken[full+".part"] {
			continue
		}
		if _, err := os.Stat(full); err == nil {
			continue
		}
		if _, err := os.Stat(full + ".part"); err == nil {
			continue
		}
		return full
	}
}

// List returns every item, oldest first, with a fresh speed reading. The
// speed is computed here rather than by a per-row goroutine: the poller
// calls List every 800 ms, and the delta between two polls *is* the sliding
// window. A paused or finished row reports zero.
func (m *Manager) List() []Item {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	out := make([]Item, 0, len(m.items))
	for _, d := range m.items {
		if d.status == StatusRunning {
			d.computeSpeed(now)
		} else {
			d.speed.Store(0)
		}
		out = append(out, d.snapshot())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Pause stops the writers between buffers and keeps every byte so far. The
// partial file and its sidecar stay on disk, so resume — this session or the
// next — continues from the exact offsets.
func (m *Manager) Pause(id string) (*Item, error) {
	d, err := m.get(id)
	if err != nil {
		return nil, err
	}
	if err := d.pause(); err != nil {
		return nil, err
	}
	item := d.snapshot()
	return &item, nil
}

// Resume restarts a paused *or failed* download from its saved offsets. A row
// that died at 98 MB of a 1 GB file continues at 98 MB; nothing is re-fetched.
func (m *Manager) Resume(id string) (*Item, error) {
	d, err := m.get(id)
	if err != nil {
		return nil, err
	}
	if err := d.resume(); err != nil {
		return nil, err
	}
	item := d.snapshot()
	return &item, nil
}

// Cancel stops the download and deletes its partial file and sidecar.
func (m *Manager) Cancel(id string) (*Item, error) {
	d, err := m.get(id)
	if err != nil {
		return nil, err
	}
	d.cancel()
	item := d.snapshot()
	return &item, nil
}

// Shutdown stops every running download cleanly, leaving sidecars behind so
// the next daemon start can offer them for resume.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	downloads := make([]*download, 0, len(m.items))
	for _, d := range m.items {
		downloads = append(downloads, d)
	}
	m.mu.Unlock()
	for _, d := range downloads {
		if d.status == StatusRunning {
			_ = d.pause()
		}
	}
}

func (m *Manager) get(id string) (*download, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d, ok := m.items[id]
	if !ok {
		return nil, ErrNotFound
	}
	return d, nil
}

// resumable finds an interrupted attempt at the same file.
//
// A `.part.json` is written on every pause and every failure, but until now
// nothing ever read one back: a retry took a fresh name ("(1)", "(2)", ...) and
// started from byte zero, which on a multi-gigabyte file means the disk fills
// with dead partials and the download never gets further than the last crash.
//
// The sidecar is trusted only for the same URL, the same total size and the
// same ETag (when both sides know one). The `.part` it points at must still
// exist; a sidecar without its partial is a leftover, not a resume.
func (m *Manager) resumable(rawURL string, probe *probeResult) (*sidecar, string) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, ""
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".part.json") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.dir, e.Name()))
		if err != nil {
			continue
		}
		var sc sidecar
		if json.Unmarshal(b, &sc) != nil || sc.Version != 1 {
			continue
		}
		if sc.URL != rawURL || sc.TotalBytes != probe.total || len(sc.Segments) == 0 {
			continue
		}
		if sc.ETag != "" && probe.etag != "" && sc.ETag != probe.etag {
			continue // the URL now serves a different file
		}
		dest := strings.TrimSuffix(filepath.Join(m.dir, e.Name()), ".part.json")
		if _, err := os.Stat(dest + ".part"); err != nil {
			continue
		}
		if m.tracks(dest + ".part") {
			// Already a row (a recovered paused download): starting the same
			// link again must not create a second row over one file.
			continue
		}
		return &sc, dest
	}
	return nil, ""
}

// pruneLocked drops terminal rows that have been finished for a while, so a
// daemon left running for days cannot grow the queue without bound.
func (m *Manager) pruneLocked() {
	now := time.Now()
	for id, d := range m.items {
		if d.status == StatusRunning || d.status == StatusPaused {
			continue
		}
		if now.Sub(d.finishedAt) < keepTerminalFor {
			continue
		}
		delete(m.items, id)
	}
	// Hard cap: the oldest terminal rows go first.
	if len(m.items) <= maxItems {
		return
	}
	type row struct {
		id string
		at time.Time
	}
	var terminal []row
	for id, d := range m.items {
		if d.status != StatusRunning && d.status != StatusPaused {
			terminal = append(terminal, row{id, d.finishedAt})
		}
	}
	sort.Slice(terminal, func(i, j int) bool { return terminal[i].at.Before(terminal[j].at) })
	for _, r := range terminal {
		if len(m.items) <= maxItems {
			break
		}
		delete(m.items, r.id)
	}
}

// ── One download ────────────────────────────────────────────────────────

// segment is one worker's byte range and how far it has written. `done` is
// atomic: the worker adds to it, the sidecar writer and the speed window
// read it, thousands of times a second.
type segment struct {
	start int64 // first byte, inclusive
	end   int64 // last byte, inclusive; -1 when the size is unknown
	done  atomic.Int64
}

func (s *segment) length() int64 {
	if s.end < 0 {
		return -1
	}
	return s.end - s.start + 1
}

func (s *segment) remaining() int64 {
	if s.end < 0 {
		return -1
	}
	return s.end - s.start + 1 - s.done.Load()
}

func (s *segment) finished() bool {
	return s.end >= 0 && s.done.Load() >= s.length()
}

type download struct {
	id           string
	url          string
	referer      string
	filename     string
	partPath     string
	sidePath     string
	totalBytes   int64
	ranged       bool
	etag         string
	lastModified string
	ua           string // the identity the probe was answered under

	client *http.Client
	log    *slog.Logger

	mu         sync.Mutex
	status     string
	errText    string
	finishedAt time.Time
	file       *os.File
	stop       context.CancelFunc
	segs       []*segment

	received   atomic.Int64
	speed      atomic.Int64
	lastBytes  atomic.Int64
	lastSample atomic.Int64 // unix nanos of the previous speed sample

	// How many sockets are actually open right now, and how many this host
	// has agreed to. A 429 halves the limit; each finished segment raises it
	// back by one. Sixteen requests to a host that wants five is how a
	// healthy file gets an IP-level ban instead of a download.
	gateMu    sync.Mutex
	active    int
	concLimit int
}

// tracks reports whether a partial path already belongs to a row.
func (m *Manager) tracks(partPath string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range m.items {
		if d.partPath == partPath {
			return true
		}
	}
	return false
}

// runningOrPaused finds the row for a URL that is still unfinished.
func (m *Manager) runningOrPaused(rawURL string) *download {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, d := range m.items {
		if d.url == rawURL && (d.status == StatusPaused || d.status == StatusRunning) {
			return d
		}
	}
	return nil
}

// adoptSidecar copies the progress a previous run left behind into this one.
//
// Segments are matched by index and only when their bounds agree: a different
// split (the huge-file rule can raise the socket count) writes each worker at
// a different offset, and adopting a `done` that belongs to another range would
// silently corrupt the file. A mismatch is not an error — the download simply
// starts clean, which is what the old code always did.
func (d *download) adoptSidecar(sc *sidecar) int64 {
	if len(sc.Segments) != len(d.segs) {
		return 0
	}
	for i, s := range sc.Segments {
		if s.Start != d.segs[i].start || s.End != d.segs[i].end {
			return 0
		}
		if s.Done < 0 || s.Done > d.segs[i].length() {
			return 0
		}
	}
	var total int64
	for i, s := range sc.Segments {
		d.segs[i].done.Store(s.Done)
		total += s.Done
	}
	// The counters follow the bytes that are already on disk, so the panel
	// shows 43 GB / 46 GB instead of 0% next to a file that is nearly done.
	d.received.Store(total)
	d.lastBytes.Store(total)
	d.lastSample.Store(time.Now().UnixNano())
	return total
}

// open creates the partial file at its final size, so every segment can
// WriteAt into its own hole without contending on growth.
func (d *download) open() error {
	f, err := os.OpenFile(d.partPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("file nahi ban paayi: %w", err)
	}
	// Sparse first, truncate second. On NTFS a non-sparse file zero-fills and
	// allocates every byte between the current end and the offset a worker
	// writes at, which for a multi-segment download means gigabytes of zeros
	// before the first real byte lands (see sparse_windows.go).
	if err := markSparse(f); err != nil {
		d.log.Warn("partial file is not sparse - unwritten gaps will cost disk",
			"id", d.id, "path", d.partPath, "err", err)
	}
	if d.totalBytes > 0 {
		if err := f.Truncate(d.totalBytes); err != nil {
			f.Close()
			return fmt.Errorf("file reserve nahi hui: %w", err)
		}
	}
	d.mu.Lock()
	d.file = f
	d.mu.Unlock()
	return nil
}

// run drives the workers and decides the final status. One goroutine per
// download, started once; resume starts another after the previous one
// exited (the WaitGroup inside makes sure of that).
func (d *download) run() {
	defer func() {
		if r := recover(); r != nil {
			diagf("panic id=%s err=%v", d.id, r)
			d.fail(fmt.Errorf("downloader panic: %v", r))
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	d.stop = cancel
	d.status = StatusRunning
	d.mu.Unlock()

	// Flush the resume state while the bytes are still moving. Until this
	// existed the sidecar was only written on pause and on error, so a crash
	// (or a kill from the updater) lost every offset since the last pause - and
	// a 45 GB partial with no sidecar cannot be resumed at all.
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				d.mu.Lock()
				d.saveSidecarLocked()
				d.mu.Unlock()
			}
		}
	}()

	// The stall watchdog. A transient error is allowed to retry for as long as
	// the network needs; a host that has produced no byte at all for
	// `stallLimit` is a different thing, and the row must say so instead of
	// spinning "running" at 0.0 MB/s until the user gives up on it.
	go func() {
		t := time.NewTicker(stallEvery)
		defer t.Stop()
		last := d.received.Load()
		lastAt := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				cur := d.received.Load()
				if cur != last {
					last, lastAt = cur, time.Now()
					continue
				}
				if d.isRunning() && time.Since(lastAt) > stallLimit {
					d.fail(fmt.Errorf("server se %s se koi byte nahi aa raha",
						stallLimit.Truncate(time.Second)))
					cancel()
					return
				}
			}
		}
	}()

	var wg sync.WaitGroup
	for i := range d.segs {
		if d.segs[i].finished() {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := d.fetchSegment(ctx, i); err != nil && ctx.Err() == nil {
				d.fail(err)
				cancel() // one broken segment ends the rest; nothing to gain
			}
		}(i)
	}
	wg.Wait()
	cancel()

	// The status may already be paused/cancelled — those paths set it and
	// cancelled this same context; only a clean finish lands here.
	d.mu.Lock()
	if d.status == StatusRunning {
		if d.allFinished() {
			d.finishLocked()
		} else {
			// Workers exited without an error and without finishing: the
			// context was cancelled from Pause/Cancel, whose own status
			// write wins. If somehow neither happened, report it honestly.
			d.status = StatusError
			d.errText = "download adhoora reh gaya"
			d.finishedAt = time.Now()
			d.saveSidecarLocked()
		}
	}
	d.mu.Unlock()
}

func (d *download) allFinished() bool {
	for _, s := range d.segs {
		if !s.finished() {
			return false
		}
	}
	return true
}

// finishLocked renames the partial into place. Caller holds d.mu.
func (d *download) finishLocked() {
	if d.file != nil {
		d.file.Close()
		d.file = nil
	}
	final := strings.TrimSuffix(d.partPath, ".part")
	if err := renameWithRetry(d.partPath, final); err != nil {
		// Windows can hold a file that was just written (the antivirus scan of
		// a fresh 45 GB file is not instant). The bytes are all here, so the
		// sidecar must stay: the next start finishes the job instead of
		// declaring a complete download dead.
		d.status = StatusError
		d.errText = "file rename nahi hui: " + err.Error()
		d.finishedAt = time.Now()
		d.saveSidecarLocked()
		diagf("rename fail id=%s err=%v", d.id, err)
		return
	}
	d.status = StatusDone
	d.finishedAt = time.Now()
	d.speed.Store(0)
	diagf("done id=%s bytes=%d", d.id, d.totalBytes)
	_ = os.Remove(d.sidePath)
}

// renameWithRetry gives a freshly written file a few seconds to stop being
// held by the antivirus / indexer before reporting a failure.
func renameWithRetry(from, to string) error {
	var err error
	for i := 0; i < 12; i++ {
		if err = os.Rename(from, to); err == nil {
			return nil
		}
		time.Sleep(time.Duration(150+150*i) * time.Millisecond)
	}
	return err
}

// fetchSegment pulls one range until it is done, reconnecting on its own
// after a dropped connection. A retry resumes from the exact byte the
// writer stopped at — no byte is ever re-received into the file twice.
func (d *download) fetchSegment(ctx context.Context, i int) error {
	seg := d.segs[i]
	for attempt := 0; ; attempt++ {
		// Hold a slot only while a request is actually open, so the limit is
		// the number of sockets, not the number of goroutines.
		if !d.acquire(ctx) {
			return ctx.Err()
		}
		before := seg.done.Load()
		err := d.fetchRange(ctx, seg)
		d.release()
		if err == nil || ctx.Err() != nil {
			return err
		}
		if seg.finished() {
			return nil
		}
		// A 404 or a login wall is an answer. Waiting will not change it, and
		// a multi-GB file must not sit "running" on a link that is dead.
		if permanent(err) {
			return fmt.Errorf("segment %d: %w", i, err)
		}

		// Every byte that reached the disk means the connection was fine and
		// this is a fresh blip: give the next attempt a fresh budget instead
		// of carrying a half-hour-old failure count into hour three.
		if seg.done.Load() > before {
			attempt = 0
			d.speedUp()
		}

		backoff := time.Duration(1<<min(attempt, 5)) * retryBase
		var rl *rateLimitError
		if errors.As(err, &rl) {
			// Fewer sockets is the actual fix for a 429 - retrying sixteen at
			// once is what earned the 429.
			d.slowDown()
			backoff = rateLimitBase << min(attempt, 4)
			if rl.wait > backoff {
				backoff = rl.wait
			}
		}
		// Capped, not terminal: a 90 GB file takes hours and the network is
		// allowed to have a bad minute. The stall watchdog is what ends a row
		// whose host has genuinely stopped answering.
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}

		d.log.Warn("download segment retrying",
			"id", d.id, "segment", i, "attempt", attempt+1, "wait", backoff, "err", err)
		diagf("retry id=%s seg=%d attempt=%d wait=%s err=%v", d.id, i, attempt+1, backoff, err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
}

// acquire takes one of the host's sockets, waiting while the limit is full.
// A short sleep instead of a cond var: the wait is at most one backoff, and
// the context check has to work anyway.
func (d *download) acquire(ctx context.Context) bool {
	for {
		if ctx.Err() != nil {
			return false
		}
		d.gateMu.Lock()
		if d.concLimit == 0 {
			d.concLimit = len(d.segs)
			if d.concLimit < 1 {
				d.concLimit = 1
			}
		}
		if d.active < d.concLimit {
			d.active++
			d.gateMu.Unlock()
			return true
		}
		d.gateMu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
}

func (d *download) release() {
	d.gateMu.Lock()
	if d.active > 0 {
		d.active--
	}
	d.gateMu.Unlock()
}

// slowDown halves the socket budget after a 429. The floor is 2: one socket
// still makes progress, but a single connection rarely saturates a line, and
// the limit climbs back as soon as the host is happy again.
func (d *download) slowDown() {
	d.gateMu.Lock()
	floor := len(d.segs)
	if floor > 2 {
		floor = 2
	}
	if d.concLimit == 0 {
		d.concLimit = len(d.segs)
	}
	if d.concLimit > floor {
		d.concLimit /= 2
		if d.concLimit < floor {
			d.concLimit = floor
		}
	}
	limit := d.concLimit
	d.gateMu.Unlock()
	d.log.Info("download slowed down after a rate limit", "id", d.id, "sockets", limit)
	diagf("slowdown id=%s sockets=%d", d.id, limit)
}

// speedUp raises the socket budget by one after a segment finishes cleanly.
// It never goes above the number of segments, so nothing over-connects.
func (d *download) speedUp() {
	d.gateMu.Lock()
	if d.concLimit < len(d.segs) {
		d.concLimit++
	}
	limit := d.concLimit
	d.gateMu.Unlock()
	diagf("speedup id=%s sockets=%d", d.id, limit)
}

// stallLimit ends a row whose host has stopped answering entirely: no byte
// for this long while running means nothing is coming, not that we should
// wait forever. It is a variable so a test does not need five minutes.
var stallLimit = 5 * time.Minute

// stallEvery is how often the watchdog samples the byte counter.
var stallEvery = 15 * time.Second

func (d *download) isRunning() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.status == StatusRunning
}

// fetchRange performs one request for the segment's remaining bytes and
// writes them to disk as they arrive. Never holds more than one buffer.
//
// Three hard lessons are baked in here:
//   - an idle connection (no bytes for `idleTimeout`) is cut and retried
//     instead of hanging the row at 0.0 MB forever;
//   - a range that ends short is an ERROR, not success — the old code
//     returned nil on EOF and quietly abandoned the tail of the segment
//     ("download adhoora reh gaya");
//   - a resumed non-ranged transfer must skip the bytes already on disk,
//     because the server streams the file from 0 again.
func (d *download) fetchRange(ctx context.Context, seg *segment) error {
	start := seg.start + seg.done.Load()
	if seg.end >= 0 && start > seg.end {
		return nil
	}

	// rwctx lets the watchdog cut THIS attempt — and unblock a body read
	// stuck on a silent connection — without touching the download's own
	// context (pause and cancel keep their meaning).
	rwctx, rwcancel := context.WithCancel(ctx)
	defer rwcancel()

	req, err := d.newRequest(rwctx, start)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusPartialContent:
		// the expected answer for a ranged request
	case http.StatusOK:
		// A server that ignores Range would corrupt a multi-segment file
		// with overlapping writes — refuse instead. For the single-segment
		// (non-ranged) download this is the normal answer, and since the
		// response always starts at byte 0, a resume must skip the bytes
		// that are already on the disk before the writers take over.
		if d.ranged && len(d.segs) > 1 {
			return errors.New("server ne Range header ko ignore kar diya")
		}
		if !d.ranged && start > 0 {
			if _, serr := io.CopyN(io.Discard, resp.Body, start); serr != nil {
				return serr
			}
		}
	default:
		if isRateLimited(resp.StatusCode) {
			return &rateLimitError{status: resp.StatusCode, wait: retryAfter(resp.Header.Get("Retry-After"))}
		}
		return &statusError{status: resp.StatusCode}
	}

	// The idle watchdog: when no byte has arrived for `idleTimeout`, cancel
	// rwctx (net/http closes the connection, which unblocks the read below)
	// and let the reconnect in fetchSegment resume from the exact offset
	// that reached the disk.
	var lastProgress atomic.Int64
	lastProgress.Store(time.Now().UnixNano())
	watched := make(chan struct{})
	defer close(watched)
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-watched:
				return
			case <-tick.C:
				idle := time.Since(time.Unix(0, lastProgress.Load()))
				if idle > idleTimeout {
					d.log.Warn("download segment idle, reconnecting",
						"id", d.id, "idle", idle.Truncate(time.Second).String())
					rwcancel()
					return
				}
			}
		}
	}()

	buf := bufPool.Get().([]byte)
	defer bufPool.Put(buf)

	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := d.file.WriteAt(buf[:n], seg.start+seg.done.Load()); werr != nil {
				return werr
			}
			seg.done.Add(int64(n))
			d.received.Add(int64(n))
			lastProgress.Store(time.Now().UnixNano())
		}
		if rerr != nil {
			if errors.Is(rerr, io.EOF) {
				// EOF means "the server stopped sending" — for a bound
				// segment that is only done when every byte arrived.
				// Anything short is retryable, not success.
				if seg.end >= 0 && !seg.finished() {
					return io.ErrUnexpectedEOF
				}
				return nil
			}
			return rerr
		}
		if rwctx.Err() != nil {
			return rwctx.Err()
		}
	}
}

func (d *download) newRequest(ctx context.Context, start int64) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.url, nil)
	if err != nil {
		return nil, err
	}
	if d.referer != "" {
		req.Header.Set("Referer", d.referer)
	}
	req.Header.Set("User-Agent", userAgent(d.ua))
	// Same reason as the probe: the byte count the server advertises must be
	// the byte count that reaches the disk (one-connection downloads have no
	// Range header, so Go would otherwise negotiate gzip).
	req.Header.Set("Accept-Encoding", "identity")
	if d.ranged {
		if seg := d.segAt(start); seg != nil && seg.end >= 0 {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, seg.end))
		} else {
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-", start))
		}
	}
	return req, nil
}

// segAt finds the segment a byte offset belongs to (for the Range header).
func (d *download) segAt(offset int64) *segment {
	for _, s := range d.segs {
		if offset >= s.start && (s.end < 0 || offset <= s.end) {
			return s
		}
	}
	return nil
}

func (d *download) pause() error {
	d.mu.Lock()
	if d.status != StatusRunning {
		d.mu.Unlock()
		return ErrBusy
	}
	d.status = StatusPaused
	cancel := d.stop
	d.mu.Unlock()

	if cancel != nil {
		cancel() // writers stop between buffers; every written byte stays
	}
	// Let run()'s workers exit before the sidecar is written, so the offsets
	// on disk are the final ones.
	time.Sleep(20 * time.Millisecond)

	d.mu.Lock()
	d.saveSidecarLocked()
	d.mu.Unlock()
	return nil
}

func (d *download) resume() error {
	d.mu.Lock()
	// An error row keeps every byte it reached (fail() writes the sidecar
	// before it says so), so "Retry" is a resume: 98 MB of a 1 GB file starts
	// at 98 MB instead of at zero. Cancelled and done rows stay unresumable -
	// their files were deleted or never had a `.part` left behind.
	if d.status != StatusPaused && d.status != StatusError {
		d.mu.Unlock()
		return ErrBusy
	}
	if d.file == nil {
		f, err := os.OpenFile(d.partPath, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			d.mu.Unlock()
			return fmt.Errorf("partial file nahi khul paayi: %w", err)
		}
		if err := markSparse(f); err != nil {
			d.log.Warn("partial file is not sparse - unwritten gaps will cost disk",
				"id", d.id, "path", d.partPath, "err", err)
		}
		if d.totalBytes > 0 {
			_ = f.Truncate(d.totalBytes)
		}
		d.file = f
	}
	d.status = StatusRunning
	d.errText = ""
	d.mu.Unlock()

	go d.run()
	return nil
}

func (d *download) cancel() {
	d.mu.Lock()
	if d.status == StatusDone || d.status == StatusCancelled {
		d.mu.Unlock()
		return
	}
	d.status = StatusCancelled
	cancel := d.stop
	d.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	time.Sleep(20 * time.Millisecond)

	d.mu.Lock()
	if d.file != nil {
		d.file.Close()
		d.file = nil
	}
	d.mu.Unlock()
	_ = os.Remove(d.partPath)
	_ = os.Remove(d.sidePath)
}

func (d *download) fail(err error) {
	d.mu.Lock()
	if d.status == StatusRunning {
		d.status = StatusError
		d.errText = err.Error()
		d.finishedAt = time.Now()
		d.saveSidecarLocked() // a failed row can still be resumed later
		diagf("fail id=%s status=%s err=%s recv=%d total=%d",
			d.id, d.status, d.errText, d.received.Load(), d.totalBytes)
	}
	d.mu.Unlock()
}

// computeSpeed turns the byte delta between two polls into bytes/second.
// Caller holds d.mu (or has exclusive List access) and the row is running.
func (d *download) computeSpeed(now time.Time) {
	cur := d.received.Load()
	lastAt := d.lastSample.Load()
	if lastAt == 0 {
		d.lastSample.Store(now.UnixNano())
		d.lastBytes.Store(cur)
		return
	}
	dt := now.Sub(time.Unix(0, lastAt)).Seconds()
	if dt < 0.2 {
		return // too soon since the last sample to divide honestly
	}
	delta := cur - d.lastBytes.Load()
	d.speed.Store(int64(float64(delta) / dt))
	d.lastBytes.Store(cur)
	d.lastSample.Store(now.UnixNano())
}

func (d *download) snapshot() Item {
	d.mu.Lock()
	defer d.mu.Unlock()
	return Item{
		ID:            d.id,
		URL:           d.url,
		Filename:      d.filename,
		Path:          strings.TrimSuffix(d.partPath, ".part"),
		TotalBytes:    d.totalBytes,
		ReceivedBytes: d.received.Load(),
		SpeedBps:      d.speed.Load(),
		Segments:      len(d.segs),
		Status:        d.status,
		Error:         d.errText,
	}
}

// ── The sidecar: what a pause, a crash or a restart must remember ───────

// sidecar is the JSON twin of a partial file. It is written on every pause
// and error, and rewritten when a daemon starts and finds orphans on disk.
type sidecar struct {
	Version      int    `json:"version"`
	URL          string `json:"url"`
	Referer      string `json:"referer,omitempty"`
	Filename     string `json:"filename"`
	TotalBytes   int64  `json:"totalBytes"`
	Ranged       bool   `json:"ranged"`
	ETag         string `json:"etag,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	Segments     []struct {
		Start int64 `json:"start"`
		End   int64 `json:"end"`
		Done  int64 `json:"done"`
	} `json:"segments"`
}

// saveSidecarLocked persists the resume state. Caller holds d.mu.
func (d *download) saveSidecarLocked() {
	if d.status == StatusDone || d.status == StatusCancelled {
		return
	}
	sc := sidecar{
		Version:      1,
		URL:          d.url,
		Referer:      d.referer,
		Filename:     d.filename,
		TotalBytes:   d.totalBytes,
		Ranged:       d.ranged,
		ETag:         d.etag,
		LastModified: d.lastModified,
	}
	for _, s := range d.segs {
		sc.Segments = append(sc.Segments, struct {
			Start int64 `json:"start"`
			End   int64 `json:"end"`
			Done  int64 `json:"done"`
		}{s.start, s.end, s.done.Load()})
	}
	b, err := json.Marshal(sc)
	if err != nil {
		return
	}
	_ = os.WriteFile(d.sidePath, b, 0o644)
}

// ── Helpers ─────────────────────────────────────────────────────────────

var bufPool = sync.Pool{
	New: func() any {
		b := make([]byte, BufferBytes)
		return b
	},
}

// splitSegments divides [0, total) into n pieces. An unknown total (-1)
// yields one open-ended segment, which streams to EOF.
func splitSegments(total int64, n int, ranged bool) []*segment {
	if n <= 1 || !ranged || total <= 0 {
		return []*segment{{start: 0, end: total - 1}}
	}
	segs := make([]*segment, n)
	chunk := (total + int64(n) - 1) / int64(n) // ceil-divide
	for i := 0; i < n; i++ {
		start := int64(i) * chunk
		if start >= total {
			// Fewer segments than n: the last pieces would be empty.
			return segs[:i]
		}
		end := start + chunk - 1
		if end >= total {
			end = total - 1
		}
		segs[i] = &segment{start: start, end: end}
	}
	return segs
}

// parseContentRangeTotal reads the size out of `bytes 0-0/12345`. The total
// may be `*` when the server will not commit to a size.
func parseContentRangeTotal(h string) int64 {
	i := strings.LastIndex(h, "/")
	if i < 0 {
		return 0
	}
	total, err := strconv.ParseInt(strings.TrimSpace(h[i+1:]), 10, 64)
	if err != nil {
		return 0
	}
	return total
}

// filenameFromDisposition reads both spellings RFC 6266 allows:
// `filename="naam.mp4"` and the encoded `filename*=UTF-8”naam%20.mp4`.
func filenameFromDisposition(h string) string {
	if h == "" {
		return ""
	}
	if _, params, err := mime.ParseMediaType(h); err == nil {
		if name := params["filename"]; name != "" {
			return name
		}
	}
	return ""
}

var windowsBadChars = regexp.MustCompile(`[<>:"/\\|?*\x00-\x1f]`)

// sanitizeFilename makes a server-provided name safe to create on Windows:
// no path separators, no control characters, no reserved device names, no
// trailing dots or spaces (the filesystem would silently eat them).
func sanitizeFilename(name string) string {
	name = strings.TrimSpace(windowsBadChars.ReplaceAllString(name, "_"))
	name = strings.TrimRight(name, ". ")
	if name == "" {
		return "download"
	}
	if len(name) > 200 {
		ext := filepath.Ext(name)
		if len(ext) > 12 {
			ext = ""
		}
		name = name[:200-len(ext)] + ext
	}
	// CON, PRN, AUX, NUL, COM1..9, LPT1..9 cannot be created, with or
	// without an extension.
	stem := strings.ToUpper(strings.SplitN(name, ".", 2)[0])
	switch stem {
	case "CON", "PRN", "AUX", "NUL",
		"COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		return "_" + name
	}
	return name
}

func newID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

// idleTimeout is IdleTimeout in a variable so tests can shrink it (a 30 s
// watchdog would make a stall test minutes long).
var idleTimeout = IdleTimeout

// diagf appends one line to `%LOCALAPPDATA%\T9EditorLIT\dl-diag.log` — the
// machine-readable trail for "download slow / stuck / file not visible"
// reports, in the same spirit as the browser's browser-diag.log. Every
// probe, start, retry, done and failure lands here, so a stuck transfer is
// read from a file instead of guessed at. Best effort: a logging problem
// must never break a transfer. (Non-Windows daemons have no LOCALAPPDATA
// and simply log nothing extra.)
func diagf(format string, args ...any) {
	root := os.Getenv("LOCALAPPDATA")
	if root == "" {
		return
	}
	p := filepath.Join(root, "T9EditorLIT", "dl-diag.log")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[%s] %s\n", time.Now().UTC().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
}
