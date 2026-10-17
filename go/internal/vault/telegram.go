package vault

// telegram.go — the live MTProto transport.
//
// The split planner in vault.go decides *what* to send; this file is what makes
// the bytes actually leave the machine. Everything here exists because of three
// measured facts, taken from T_Dubber's tgup notes (docs/TELEGRAM_INTEGRATION_T_DUBBER.md):
//
//  1. A 5 GB source cannot fit in one Telegram message, so it arrives as three
//     1.9 GB parts (vault.go).
//  2. One TCP socket cannot fill a home uplink. To carry 3.76 MB/s across a
//     110 ms round trip you need ~404 KB in flight; a single MTProto
//     connection's window is ~232 KB, which is why one socket tops out near
//     2 MB/s. More goroutines on one client change nothing — they share the one
//     window. The fix is several *connections*, which is what the pool is for.
//  3. Nothing may be buffered whole. A part is a SectionReader over its own file
//     handle, and the uploader's read loop is the only thing that touches it.
//
// Authorisation is by QR scan, never by a typed OTP. See login.go.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gotd/td/crypto"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/uploader"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// Upload tuning, and why both numbers exist.
//
// gotd's default part size is 128 KB with one goroutine per upload, and its
// automatic growth only runs when the total size is known. At a 110 ms round
// trip a single 128 KB RPC in flight is a hard ceiling near 1.16 MB/s per
// connection. So parts go out at Telegram's maximum (512 KB, four times fewer
// RPCs than the default for the same bytes) and three of them are in flight per
// connection, which keeps ~1.5 MB on the wire per connection.
const (
	// UploadPartBytes is Telegram's maximum upload part size. It divides
	// constant.UploadMaxPartSize exactly, so it is also the fewest RPCs that
	// can carry the bytes.
	UploadPartBytes = 512 * 1024

	// uploadThreads is how many parts of ONE part-upload may be in flight on
	// one connection. Three keeps ~1.5 MB on the wire per connection, well
	// above the ~404 KB bandwidth-delay product of a typical uplink, while
	// staying inside Telegram's per-method flood limits.
	uploadThreads = 3

	// DefaultConnections is how many MTProto connections share one auth key.
	//
	// This is the whole point of the design: goroutines share a window and do
	// not help, separate connections each carry their own.
	DefaultConnections = 3

	// MaxConnections caps the pool. Past a point extra sockets stop helping
	// and start earning FLOOD_WAIT.
	MaxConnections = 8
)

// sessionFileName is the gotd session inside T9CLOUD_SESSION_DIR.
//
// One session covers every connection in the pool — one login, not one per
// connection — because a pool connection reuses the same auth key with its own
// salt rather than creating a new login.
const sessionFileName = "session.json"

// TelegramOptions configures the transport.
type TelegramOptions struct {
	// APIID and APIHash come from my.telegram.org. They identify the app, not
	// the user, and they are not secret.
	APIID   int
	APIHash string

	// SessionDir holds the session file and the resume manifests.
	SessionDir string

	// Chat is the default destination: @channel, a channel id, an invite
	// link, or "me" for the account's own Saved Messages.
	Chat string

	// Password is the account's Two-Step Verification cloud password.
	//
	// It is never asked for interactively: a daemon has no console, and a
	// prompt that cannot be answered is worse than a clear refusal. Accounts
	// with 2FA need one QR scan and then this password, once.
	Password string

	// Connections is the pool size. Zero means DefaultConnections.
	Connections int

	// Log receives transport-level detail. Nil means a quiet logger.
	Log *slog.Logger
}

// Telegram is the live MTProto client plus its connection pool.
//
// One instance is held for the daemon's lifetime: MTProto sessions are
// expensive to rebuild and an idle pool is cheap, so the client stays connected
// and only the per-run pool is opened and closed.
type Telegram struct {
	opts        TelegramOptions
	log         *slog.Logger
	sessionPath string

	mu       sync.Mutex
	client   *telegram.Client
	cancel   context.CancelFunc
	runDone  chan struct{}
	runErr   error
	ready    chan struct{}
	readyOne sync.Once
	start    time.Time

	// loginSignal carries updateLoginToken from the update handler to the QR
	// flow. Buffered and best-effort: a dropped signal costs one poll
	// interval, not a login.
	loginSignal chan struct{}

	login *loginState // the single in-flight QR attempt

	// peers caches resolved chats. Resolution costs one RPC and can fail on a
	// flaky link, while one upload run may last twenty minutes.
	peersMu sync.Mutex
	peers   map[string]resolvedPeer
}

// Compile-time proof that the transport really is what vault.Uploader asks for.
var (
	_ Uploader     = (*Telegram)(nil)
	_ LoginStarter = (*Telegram)(nil)
)

// Status is what the UI needs to decide whether a backup can even be attempted.
type Status struct {
	// Configured is false when no API credentials are set at all.
	Configured bool `json:"configured"`
	// Authorised is true when Telegram accepted the stored session on the last
	// successful Status call. A key on disk is not enough — revoked keys look
	// valid locally and only fail mid-upload.
	Authorised bool `json:"authorised"`
	// Account is a display label for the logged-in user.
	Account string `json:"account,omitempty"`
	// Chat is the configured destination.
	Chat string `json:"chat,omitempty"`
	// Connections is the pool size actually in use.
	Connections int `json:"connections"`
	// PartBytes is the split size, so the UI can show "3 parts" without
	// re-implementing the planner.
	PartBytes int64 `json:"part_bytes"`
	// SessionPath is where the auth key is stored. A path, not a credential.
	SessionPath string `json:"session_path"`
	// Detail carries the reason when something is wrong.
	Detail string `json:"detail,omitempty"`
}

// New builds an unconnected transport.
//
// Nothing touches the network until the first Authorise, Status or upload call,
// so a daemon started without Telegram credentials never opens a socket.
func New(opts TelegramOptions) *Telegram {
	if opts.Connections <= 0 {
		opts.Connections = DefaultConnections
	}
	if opts.Connections > MaxConnections {
		opts.Connections = MaxConnections
	}
	if opts.SessionDir == "" {
		// A caller that did not choose a location still needs one that
		// survives a restart, because a lost session means another QR scan.
		opts.SessionDir = filepath.Join(os.TempDir(), "t9editorlit", "telegram")
	}
	log := opts.Log
	if log == nil {
		log = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	}

	return &Telegram{
		opts:        opts,
		log:         log,
		start:       time.Now(),
		sessionPath: filepath.Join(opts.SessionDir, sessionFileName),
		ready:       make(chan struct{}),
		loginSignal: make(chan struct{}, 8),
		peers:       make(map[string]resolvedPeer),
	}
}

// Connections is the configured pool size.
func (t *Telegram) Connections() int { return t.opts.Connections }

// SessionPath is where the auth key lives. Safe to show in the UI: it is a
// path, not a credential.
func (t *Telegram) SessionPath() string { return t.sessionPath }

// Authorised reports whether an auth key is on disk.
//
// Deliberately local, so a health endpoint can answer instantly. It cannot
// detect a key Telegram has since revoked — only Status can, and the UI should
// call that before promising a backup.
func (t *Telegram) Authorised() bool {
	data, err := t.loadSession()
	return err == nil && len(data.AuthKey) > 0
}

func (t *Telegram) loadSession() (*session.Data, error) {
	loader := &session.Loader{Storage: &session.FileStorage{Path: t.sessionPath}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return loader.Load(ctx)
}

// Status asks Telegram whether the stored session still works.
//
// This is the check that separates "we have a key" from "we may upload",
// because a revoked key looks perfectly valid on disk.
func (t *Telegram) Status(ctx context.Context) (Status, error) {
	st := Status{
		Configured:  t.opts.APIID != 0 && t.opts.APIHash != "",
		Authorised:  t.Authorised(),
		SessionPath: t.sessionPath,
		Connections: t.opts.Connections,
		PartBytes:   DefaultPartBytes,
		Chat:        t.opts.Chat,
	}

	client, err := t.connect(ctx)
	if err != nil {
		st.Detail = err.Error()
		return st, err
	}

	authStatus, err := client.Auth().Status(ctx)
	if err != nil {
		if auth.IsUnauthorized(err) {
			st.Authorised = false
			st.Detail = "this Telegram session is no longer valid — scan the QR again"
			return st, nil
		}
		st.Detail = err.Error()
		return st, err
	}

	st.Authorised = authStatus.Authorized
	if authStatus.Authorized && authStatus.User != nil {
		st.Account = accountLabel(authStatus.User)
	}
	return st, nil
}

// accountLabel is what the UI shows for the connected account.
func accountLabel(u *tg.User) string {
	if u == nil {
		return ""
	}
	if u.Username != "" {
		return "@" + u.Username
	}
	name := u.FirstName
	if u.LastName != "" {
		name += " " + u.LastName
	}
	if name == "" {
		name = fmt.Sprintf("id %d", u.ID)
	}
	return name
}

// connect starts the client if it is not already running, and waits until the
// session is usable.
//
// The client's lifetime is deliberately NOT the caller's context: a caller
// polling a status endpoint goes away after a second, and the session must
// outlive it. Close is the only thing that stops the client.
func (t *Telegram) connect(ctx context.Context) (*telegram.Client, error) {
	t.mu.Lock()
	if t.client != nil {
		client := t.client
		t.mu.Unlock()
		return client, nil
	}

	if t.opts.APIID == 0 || t.opts.APIHash == "" {
		t.mu.Unlock()
		return nil, ErrNotConfigured
	}
	if err := os.MkdirAll(t.opts.SessionDir, 0o700); err != nil {
		t.mu.Unlock()
		return nil, fmt.Errorf("creating the Telegram session directory: %w", err)
	}

	client := telegram.NewClient(t.opts.APIID, t.opts.APIHash, telegram.Options{
		SessionStorage: &session.FileStorage{Path: t.sessionPath},
		// An update handler is required for the QR flow: updateLoginToken is
		// how Telegram says the phone tapped confirm, and it is what turns a
		// 30-second wait into an instant one.
		UpdateHandler: telegram.UpdateHandlerFunc(t.handleUpdate),
		Device: telegram.DeviceConfig{
			DeviceModel:    "T9EditorLIT",
			SystemVersion:  "Windows",
			AppVersion:     "1.0",
			SystemLangCode: "en",
			LangCode:       "en",
		},
	})

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	done := make(chan struct{})

	t.client, t.cancel, t.runDone, t.runErr = client, cancel, done, nil
	t.mu.Unlock()

	go func() {
		defer close(done)
		err := client.Run(runCtx, func(ctx context.Context) error {
			t.readyOne.Do(func() { close(t.ready) })
			<-ctx.Done()
			return ctx.Err()
		})
		t.mu.Lock()
		t.runErr = err
		t.mu.Unlock()
	}()

	select {
	case <-t.ready:
		t.log.Info("telegram connected",
			"session", filepath.Base(t.sessionPath),
			"connections", t.opts.Connections)
		return client, nil
	case <-done:
		t.mu.Lock()
		runErr := t.runErr
		t.client = nil
		t.mu.Unlock()
		cancel()
		if runErr == nil || errors.Is(runErr, context.Canceled) {
			return nil, errors.New("the Telegram client stopped before it finished connecting")
		}
		return nil, fmt.Errorf("connecting to Telegram: %w", runErr)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Close stops the client and releases its sockets.
func (t *Telegram) Close() {
	t.mu.Lock()
	cancel, done := t.cancel, t.runDone
	t.client, t.cancel, t.runDone = nil, nil, nil
	t.mu.Unlock()

	if cancel == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.log.Warn("telegram client did not shut down within 5s")
	}
}

// handleUpdate is the client's update handler.
//
// Exactly one update is interesting: the phone confirming a scanned QR.
// Everything else is ignored rather than stored — this daemon has no business
// holding a user's message stream.
func (t *Telegram) handleUpdate(_ context.Context, u tg.UpdatesClass) error {
	if hasLoginToken(u) {
		select {
		case t.loginSignal <- struct{}{}:
		default:
		}
	}
	return nil
}

// hasLoginToken reports whether an update batch contains updateLoginToken.
func hasLoginToken(u tg.UpdatesClass) bool {
	switch v := u.(type) {
	case *tg.UpdateShort:
		if _, ok := v.Update.(*tg.UpdateLoginToken); ok {
			return true
		}
	case *tg.Updates:
		return listHasLoginToken(v.Updates)
	case *tg.UpdatesCombined:
		return listHasLoginToken(v.Updates)
	}
	return false
}

func listHasLoginToken(items []tg.UpdateClass) bool {
	for _, item := range items {
		if _, ok := item.(*tg.UpdateLoginToken); ok {
			return true
		}
	}
	return false
}

// ── the Uploader interface ───────────────────────────────────────────────

// Send streams one part to a chat.
//
// This is the interface the planner drives, and it is intentionally the plain
// path: one part, one pool, no manifest. UploadParts is what a real 5 GB send
// uses.
func (t *Telegram) Send(ctx context.Context, chatID, path string, offset, size int64) (int, error) {
	parts, _, err := PlanFile(path, DefaultPartBytes)
	if err != nil {
		return 0, err
	}
	part, ok := findPart(parts, offset, size)
	if !ok {
		return 0, fmt.Errorf("no planned part matches offset %d size %d", offset, size)
	}

	ids, err := t.UploadParts(ctx, chatID, path, parts, []int{part.Index}, nil)
	if err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, fmt.Errorf("Telegram returned no message id for part %d", part.Index)
	}
	return ids[0], nil
}

func findPart(parts []Part, offset, size int64) (Part, bool) {
	for _, p := range parts {
		if p.Offset == offset && p.Size == size {
			return p, true
		}
	}
	return Part{}, false
}

// Authorise performs the whole QR flow in one call.
//
// The daemon does not use it: the desktop app drives login in steps so it can
// render the code and show progress. It exists for the Uploader interface, for
// tests, and for one-shot invocations.
func (t *Telegram) Authorise(ctx context.Context) error {
	challenge, err := t.BeginLogin(ctx)
	if err != nil {
		return err
	}

	// The QR rotates every ~30s, so the URL handed out first goes stale.
	// Poll until the session is authorised, reading each rotation from the
	// challenge so a caller can redraw.
	for {
		state, err := t.PollLogin(ctx, challenge.ID)
		if err != nil {
			return err
		}
		switch state.Phase {
		case LoginAuthorised:
			return nil
		case LoginFailed:
			return errors.New(state.Detail)
		case LoginExpired:
			return errors.New("the QR expired without being scanned")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(400 * time.Millisecond):
		}
	}
}

// ── the real send path ───────────────────────────────────────────────────

// UploadParts sends the given part indexes of a file, in parallel across the
// connection pool.
//
// parts is the whole plan so digests and the manifest stay aligned with it;
// only the indexes in send are transmitted, which is how a resume skips what is
// already stored. report may be nil.
func (t *Telegram) UploadParts(
	ctx context.Context,
	chatID, path string,
	parts []Part,
	send []int,
	report func(Progress),
) ([]int, error) {
	if len(send) == 0 {
		return nil, nil
	}

	client, err := t.connect(ctx)
	if err != nil {
		return nil, err
	}
	if !t.Authorised() {
		return nil, ErrNotAuthorised
	}

	peer, err := t.peer(ctx, client, chatID)
	if err != nil {
		return nil, err
	}

	// One pool for the whole run, not one per part: connections are the scarce
	// resource, and opening four sockets per part would cost more than the
	// upload it is meant to accelerate.
	pool, err := client.Pool(int64(t.opts.Connections))
	if err != nil {
		return nil, fmt.Errorf("opening the connection pool: %w", err)
	}
	defer pool.Close()

	api := tg.NewClient(pool)
	total := totalSize(parts)

	manifest, err := openManifest(t.opts.SessionDir, path, total, partSpan(parts), chatID)
	if err != nil {
		return nil, err
	}
	// Adopt the plan so every part is on record before the first byte moves:
	// if the daemon dies mid-transfer, the manifest already knows what the
	// file was split into.
	manifest.adopt(parts)
	manifest.setUser(peer.username)

	tracker := newProgressTracker(report, total, len(parts), t.opts.Connections)

	// The caller's context must not cancel a send that is already streaming
	// 1.9 GB — an HTTP client giving up is not a reason to throw away the
	// bytes. Cancellation arrives through Close.
	workCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()

	ids := make([]int, len(parts))

	var (
		mu     sync.Mutex
		failed error
		queue  = make(chan int)
	)

	// One worker per pool connection. Each in-flight part sits on its own
	// MTProto connection and therefore its own TCP receive window, which is
	// the only thing that actually raises the rate. Goroutines sharing one
	// connection would share one window and change nothing.
	workers := t.opts.Connections
	if workers > len(send) {
		workers = len(send)
	}

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for index := range queue {
				if workCtx.Err() != nil {
					return
				}
				part := parts[index]

				id, link, err := t.sendPart(workCtx, api, peer, path, part, len(parts), tracker)
				if err != nil {
					mu.Lock()
					if failed == nil {
						failed = fmt.Errorf("part %d/%d (%s): %w",
							part.Index+1, len(parts), part.Name, err)
					}
					mu.Unlock()
					continue
				}

				ids[index] = id
				manifest.record(part.Index, id, link)
				tracker.partStored(part)
			}
		}()
	}

	go func() {
		defer close(queue)
		for _, index := range send {
			select {
			case queue <- index:
			case <-workCtx.Done():
				return
			}
		}
	}()

	wg.Wait()

	if failed != nil {
		manifest.fail(failed.Error())
		return nil, failed
	}

	out := make([]int, 0, len(ids))
	for i := range parts {
		if ids[i] != 0 {
			out = append(out, ids[i])
		}
	}
	return out, nil
}

// sendPart streams one part and posts it.
//
// Everything here streams: an independent file handle per part (concurrent
// workers must not share a Seek position), a SectionReader clipped to the
// part, and gotd's uploader holding a pool of 512 KB × 3 buffers. A 1.9 GB part
// therefore costs about 1.5 MB of RAM, exactly like a 512 KB one.
func (t *Telegram) sendPart(
	ctx context.Context,
	api *tg.Client,
	peer resolvedPeer,
	path string,
	part Part,
	count int,
	tracker *progressTracker,
) (int, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, "", fmt.Errorf("open %s: %w", filepath.Base(path), err)
	}
	defer f.Close()

	section := io.NewSectionReader(f, part.Offset, part.Size)
	tracker.partStarted(part)

	up := uploader.NewUploader(api).
		WithPartSize(UploadPartBytes).
		WithThreads(uploadThreads).
		WithProgress(&chunkReporter{part: part.Index, tracker: tracker})

	// The size is passed explicitly so gotd knows the part count before the
	// first RPC. With a -1 total it has to infer that from the stream, which
	// is one less thing that can go wrong on a 1.9 GB send.
	file, err := up.Upload(ctx, uploader.NewUpload(part.Name, section, part.Size))
	if err != nil {
		tracker.partFailed(part)
		return 0, "", err
	}

	caption := partCaption(path, part, count)
	updates, err := sendDocument(ctx, api, peer.input, part.Name, caption, file)
	if err != nil {
		tracker.partFailed(part)
		return 0, "", err
	}

	id := firstMessageID(updates)
	if id == 0 {
		tracker.partFailed(part)
		return 0, "", fmt.Errorf("Telegram accepted %s but returned no message id", part.Name)
	}
	return id, partLink(peer, id), nil
}

// sendDocument posts an uploaded file as a message.
//
// FLOOD_WAIT is honoured by waiting: Telegram asks for a specific delay and
// expects the request again, so returning an error here would throw away 1.9 GB
// of finished upload to save a minute of patience.
func sendDocument(
	ctx context.Context,
	api *tg.Client,
	peer tg.InputPeerClass,
	name, caption string,
	file tg.InputFileClass,
) (tg.UpdatesClass, error) {
	req := &tg.MessagesSendMediaRequest{
		Peer:     peer,
		Message:  caption,
		RandomID: randomID(),
		Media: &tg.InputMediaUploadedDocument{
			File:     file,
			MimeType: MimeFor(name),
			Attributes: []tg.DocumentAttributeClass{
				&tg.DocumentAttributeFilename{FileName: name},
			},
		},
	}

	for {
		updates, err := api.MessagesSendMedia(ctx, req)
		if err == nil {
			return updates, nil
		}

		if flood, waitErr := tgerr.FloodWait(ctx, err); flood {
			slog.Debug("telegram flood wait honoured", "err", waitErr)
			req.RandomID = randomID()
			continue
		}
		if auth.IsUnauthorized(err) {
			return nil, ErrSessionRevoked
		}
		return nil, err
	}
}

// randomID is the per-request nonce Telegram uses to deduplicate sends.
//
// A retried send after FLOOD_WAIT must carry a new one, or the server treats
// it as the message it already accepted and never posts anything.
func randomID() int64 {
	id, err := crypto.RandInt64(crypto.DefaultRand())
	if err != nil {
		// crypto/rand does not fail in practice; a timestamp keeps requests
		// distinct rather than panicking an upload worker.
		return time.Now().UnixNano()
	}
	return id
}

// chunkReporter adapts gotd's per-RPC progress into the run total.
//
// ProgressState.Uploaded is cumulative within one upload, so the delta since the
// previous callback is what the run total needs — three concurrent parts each
// counting from zero would otherwise triple the reported bytes.
type chunkReporter struct {
	part    int
	tracker *progressTracker
	last    int64
}

func (c *chunkReporter) Chunk(_ context.Context, state uploader.ProgressState) error {
	if state.Uploaded <= c.last {
		return nil
	}
	delta := state.Uploaded - c.last
	c.last = state.Uploaded
	c.tracker.chunk(c.part, delta)
	return nil
}

// ── progress ─────────────────────────────────────────────────────────────

// progressTracker turns concurrent upload events into one monotonic byte count.
//
// Every part keeps its own partial count, so "bytes sent" is the sum of what is
// in flight right now plus what has landed. Counting only completed parts would
// make progress jump by 1.9 GB three times and sit at zero in between, which is
// useless in a UI — and it would make the rate figure swing by a factor of
// three depending on where in the run you looked.
type progressTracker struct {
	mu          sync.Mutex
	sent        int64         // monotonic: in-flight bytes plus stored bytes
	stored      int           // parts confirmed by Telegram
	inflight    map[int]int64 // part index → bytes sent so far, per part
	total       int64
	count       int
	connections int
	phase       string
	current     int
	started     time.Time
	report      func(Progress)
}

func newProgressTracker(report func(Progress), total int64, count, connections int) *progressTracker {
	return &progressTracker{
		inflight:    make(map[int]int64, connections),
		total:       total,
		count:       count,
		connections: connections,
		phase:       PhaseHashing,
		started:     time.Now(),
		report:      report,
	}
}

func (p *progressTracker) setPhase(phase string) {
	p.mu.Lock()
	p.phase = phase
	p.mu.Unlock()
	p.emit("")
}

func (p *progressTracker) partStarted(part Part) {
	p.mu.Lock()
	// A retry of the same part must not keep the bytes of the failed attempt.
	p.sent -= p.inflight[part.Index]
	delete(p.inflight, part.Index)
	p.current = part.Index
	p.mu.Unlock()
	p.emit(fmt.Sprintf("sending part %d/%d (%s)", part.Index+1, p.count, humanBytes(part.Size)))
}

func (p *progressTracker) chunk(index int, delta int64) {
	p.mu.Lock()
	p.inflight[index] += delta
	p.sent += delta
	p.mu.Unlock()
	p.emit("")
}

// partStored counts the part whole, not just the bytes the progress callbacks
// happened to report.
//
// The last RPC of a part can complete without its chunk callback being seen, so
// topping the part up to its real size is what keeps the total equal to what
// Telegram actually received.
func (p *progressTracker) partStored(part Part) {
	p.mu.Lock()
	if missing := part.Size - p.inflight[part.Index]; missing > 0 {
		p.sent += missing
	}
	delete(p.inflight, part.Index)
	p.stored++
	p.mu.Unlock()
	p.emit(fmt.Sprintf("part %d/%d stored", part.Index+1, p.count))
}

func (p *progressTracker) partFailed(part Part) {
	p.mu.Lock()
	p.sent -= p.inflight[part.Index]
	delete(p.inflight, part.Index)
	p.mu.Unlock()
	p.emit(fmt.Sprintf("part %d/%d failed", part.Index+1, p.count))
}

func (p *progressTracker) emit(message string) {
	if p.report == nil {
		return
	}

	p.mu.Lock()
	elapsed := time.Since(p.started).Seconds()
	if elapsed < 0.001 {
		elapsed = 0.001
	}
	snapshot := Progress{
		Phase:       p.phase,
		PartIndex:   p.current,
		PartCount:   p.count,
		PartsDone:   p.stored,
		BytesDone:   p.sent,
		BytesTotal:  p.total,
		BytesPerSec: float64(p.sent) / elapsed,
		ElapsedSec:  elapsed,
		Connections: p.connections,
		Message:     message,
	}
	report := p.report
	p.mu.Unlock()

	report(snapshot)
}

// ── peer resolution ──────────────────────────────────────────────────────

// peer resolves and caches a chat.
func (t *Telegram) peer(ctx context.Context, client *telegram.Client, chatID string) (resolvedPeer, error) {
	key := chatID
	if key == "" {
		key = t.opts.Chat
	}

	t.peersMu.Lock()
	cached, ok := t.peers[key]
	t.peersMu.Unlock()
	if ok {
		return cached, nil
	}

	target, err := ParseTarget(key)
	if err != nil {
		return resolvedPeer{}, err
	}

	resolved, err := resolvePeer(ctx, client.API(), target)
	if err != nil {
		return resolvedPeer{}, err
	}

	t.peersMu.Lock()
	t.peers[key] = resolved
	t.peersMu.Unlock()
	return resolved, nil
}

// partCaption is the text under a part in the chat.
//
// It states the part number and the size, because a chat holding three 1.9 GB
// files is otherwise unmanageable — and later reassembly depends on the order
// being obvious at a glance.
func partCaption(source string, p Part, count int) string {
	base := filepath.Base(source)
	if count <= 1 {
		return fmt.Sprintf("%s (%s)", base, humanBytes(p.Size))
	}
	return fmt.Sprintf("Part %d/%d · %s (%s)",
		p.Index+1, count, base, humanBytes(p.Size))
}

// partLink builds a t.me URL, or "" when the chat has no public username.
func partLink(peer resolvedPeer, messageID int) string {
	if peer.username == "" || messageID == 0 {
		return ""
	}
	return fmt.Sprintf("https://t.me/%s/%d", peer.username, messageID)
}

func totalSize(parts []Part) int64 {
	var n int64
	for _, p := range parts {
		n += p.Size
	}
	return n
}

// partSpan is the largest part in the plan, recorded as the manifest's part
// size so a differently split plan cannot resume onto the same file.
func partSpan(parts []Part) int64 {
	var n int64
	for _, p := range parts {
		if p.Size > n {
			n = p.Size
		}
	}
	return n
}
