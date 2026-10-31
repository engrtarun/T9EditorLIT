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

	// MaxRetries is how often a broken segment reconnects before the whole
	// download fails. Each attempt resumes from the exact byte it stopped at.
	MaxRetries = 5

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
				Proxy: http.ProxyFromEnvironment,
				DialContext: (&net.Dialer{
					Timeout:   10 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				TLSHandshakeTimeout: 10 * time.Second,
				MaxIdleConnsPerHost: segs + 2,
			},
		}
	}

	return &Manager{
		dir:             dir,
		segments:        segs,
		minSegmentBytes: minSeg,
		client:          client,
		log:             log,
		items:           map[string]*download{},
	}, nil
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

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	probe, err := m.probe(ctx, rawURL, referer)
	if err != nil {
		return nil, err
	}

	// The filename prefers the server's Content-Disposition (that is what a
	// browser shows), then the URL path, then a fixed name.
	name := probe.filename
	if name == "" {
		name = path.Base(parsed.Path)
	}
	name = sanitizeFilename(name)

	dest := m.reservePath(name)

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
}

// probe asks the server what it is about to serve.
//
// HEAD first — it is cheap and most servers answer it. A server that refuses
// HEAD (405, or a CDN that treats it differently) falls back to a one-byte
// ranged GET, which is the more honest question anyway: a 206 answer proves
// range support regardless of what any header claims.
func (m *Manager) probe(ctx context.Context, rawURL, referer string) (*probeResult, error) {
	head, err := m.newRequest(ctx, http.MethodHead, rawURL, referer)
	if err != nil {
		return nil, err
	}
	if resp, err := m.client.Do(head); err == nil {
		io.Copy(io.Discard, resp.Body) // drain, so the connection can be reused
		resp.Body.Close()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			res := &probeResult{
				total:        resp.ContentLength,
				ranged:       strings.EqualFold(resp.Header.Get("Accept-Ranges"), "bytes"),
				filename:     filenameFromDisposition(resp.Header.Get("Content-Disposition")),
				etag:         resp.Header.Get("ETag"),
				lastModified: resp.Header.Get("Last-Modified"),
			}
			// Accept-Ranges missing is not proof of no support — ask with a
			// real Range request before giving up on splitting.
			if !res.ranged {
				if ranged, total := m.probeRange(ctx, rawURL, referer); ranged {
					res.ranged, res.total = true, total
				}
			}
			return res, nil
		}
	}

	// HEAD failed outright — the one-byte GET is the fallback.
	ranged, total := m.probeRange(ctx, rawURL, referer)
	res := &probeResult{total: total, ranged: ranged}
	if !ranged {
		return nil, fmt.Errorf("server ne file dene se mana kar diya")
	}
	return res, nil
}

// probeRange sends `Range: bytes=0-0`. A 206 answers with the full size in
// Content-Range (`bytes 0-0/12345`) and proves range support in one shot.
func (m *Manager) probeRange(ctx context.Context, rawURL, referer string) (bool, int64) {
	req, err := m.newRequest(ctx, http.MethodGet, rawURL, referer)
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

func (m *Manager) newRequest(ctx context.Context, method, rawURL, referer string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	// Downloading from inside the app's browser should look like it: some
	// hosts (YouTube's CDN among them) refuse a bare request with no referrer.
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36")
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

// Resume restarts a paused download from its saved offsets.
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
}

// open creates the partial file at its final size, so every segment can
// WriteAt into its own hole without contending on growth.
func (d *download) open() error {
	f, err := os.OpenFile(d.partPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("file nahi ban paayi: %w", err)
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
	ctx, cancel := context.WithCancel(context.Background())
	d.mu.Lock()
	d.stop = cancel
	d.status = StatusRunning
	d.mu.Unlock()

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
	if err := os.Rename(d.partPath, final); err != nil {
		d.status = StatusError
		d.errText = "file rename nahi hui: " + err.Error()
	} else {
		d.status = StatusDone
	}
	d.finishedAt = time.Now()
	_ = os.Remove(d.sidePath)
}

// fetchSegment pulls one range until it is done, reconnecting on its own
// after a dropped connection. A retry resumes from the exact byte the
// writer stopped at — no byte is ever re-received into the file twice.
func (d *download) fetchSegment(ctx context.Context, i int) error {
	seg := d.segs[i]
	for attempt := 0; ; attempt++ {
		err := d.fetchRange(ctx, seg)
		if err == nil || ctx.Err() != nil {
			return err
		}
		if seg.finished() {
			return nil
		}
		if attempt >= MaxRetries {
			return fmt.Errorf("segment %d: %w", i, err)
		}
		backoff := time.Duration(1<<attempt) * 300 * time.Millisecond
		d.log.Warn("download segment retrying",
			"id", d.id, "segment", i, "attempt", attempt+1, "err", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
	}
}

// fetchRange performs one request for the segment's remaining bytes and
// writes them to disk as they arrive. Never holds more than one buffer.
func (d *download) fetchRange(ctx context.Context, seg *segment) error {
	start := seg.start + seg.done.Load()
	if seg.end >= 0 && start > seg.end {
		return nil
	}

	req, err := d.newRequest(ctx, start)
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
		// (non-ranged) download this is the normal answer.
		if d.ranged && len(d.segs) > 1 {
			return errors.New("server ne Range header ko ignore kar diya")
		}
	default:
		return fmt.Errorf("server ne mana kar diya (status %d)", resp.StatusCode)
	}

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
		}
		if rerr != nil {
			if rerr == io.EOF {
				// A ranged request answered short: the server closed before
				// the range ended. Nil only when the segment really is done.
				return nil
			}
			return rerr
		}
		if ctx.Err() != nil {
			return ctx.Err()
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
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36")
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
	if d.status != StatusPaused {
		d.mu.Unlock()
		return ErrBusy
	}
	if d.file == nil {
		f, err := os.OpenFile(d.partPath, os.O_CREATE|os.O_RDWR, 0o644)
		if err != nil {
			d.mu.Unlock()
			return fmt.Errorf("partial file nahi khul paayi: %w", err)
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
