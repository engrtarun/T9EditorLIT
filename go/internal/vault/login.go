package vault

// login.go — authorisation by QR scan, with no OTP anywhere in it.
//
// T_Dubber's tgup refuses to start an auth flow on a machine with no console,
// because Telegram sends the login code the moment the flow begins and a
// headless run can only fail at EOF — after spending a real code on the user's
// phone for nothing. That is the right instinct and the wrong conclusion: the
// answer is not "no login on a daemon", it is "a login that needs nothing
// typed".
//
// This is that login. auth.exportLoginToken is the same call Telegram Desktop
// makes for "Link Desktop Device": the daemon asks for a token, shows it as a QR
// (tg://login?token=…), the user's already-logged-in phone scans it and taps
// confirm, and the auth key this connection is already using becomes
// authorised. No phone number is ever requested, no code is ever sent, and a
// run that is abandoned costs nothing.
//
// The one thing a scan does not cover is Two-Step Verification: Telegram
// answers auth.exportLoginToken itself with SESSION_PASSWORD_NEEDED, before any
// QR is drawn. That case is handled by answering with the configured cloud
// password, or by saying so plainly — never by silently stalling.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/auth/qrlogin"
	"github.com/gotd/td/tgerr"
)

// Errors the caller can act on. Each one says what the user should do next,
// because "upload failed" tells them nothing they can use.
var (
	// ErrNotAuthorised means there is no usable session yet.
	ErrNotAuthorised = errors.New("Telegram is not authorised yet — scan the QR from Settings → Link Desktop Device")

	// ErrSessionRevoked means Telegram rejected the stored auth key. Only a
	// fresh scan fixes it; no amount of retrying does.
	ErrSessionRevoked = errors.New("this Telegram session was revoked — scan the QR again")

	// ErrPasswordRequired means the account has Two-Step Verification and no
	// cloud password is configured.
	ErrPasswordRequired = errors.New("this account has Two-Step Verification; set TELEGRAM_2FA_PASSWORD and try again")

	// ErrLoginInProgress means a scan is already waiting.
	ErrLoginInProgress = errors.New("a Telegram login is already in progress")
)

// LoginPhase is where a QR attempt stands.
type LoginPhase string

const (
	// LoginWaiting means a QR is on screen and nobody has scanned it yet.
	LoginWaiting LoginPhase = "waiting"
	// LoginAuthorised means the session is on disk and usable.
	LoginAuthorised LoginPhase = "authorised"
	// LoginExpired means the attempt was abandoned before it was scanned.
	LoginExpired LoginPhase = "expired"
	// LoginPasswordNeeded means the account wants a 2FA cloud password that is
	// not configured.
	LoginPasswordNeeded LoginPhase = "password_needed"
	// LoginFailed means the attempt ended with an error worth showing.
	LoginFailed LoginPhase = "failed"
)

// Phases an upload run moves through, reported to the UI as it happens.
const (
	PhaseHashing   = "hashing"
	PhaseUploading = "uploading"
	PhaseDone      = "done"
)

// LoginChallenge is what the app renders, and what it polls.
//
// URL changes as the token rotates — a login token is valid for about 30
// seconds, and asking for a new one invalidates the old. That is why the
// desktop app must re-poll and redraw rather than screenshotting the first
// code it is handed.
type LoginChallenge struct {
	// ID identifies this attempt.
	ID string `json:"id"`
	// URL is the tg://login?token=… string to encode as a QR. Empty only
	// before Telegram has answered once.
	URL string `json:"url,omitempty"`
	// ExpiresUnix is when the current token dies.
	ExpiresUnix int64 `json:"expires_unix,omitempty"`
	// Phase is the state to render.
	Phase LoginPhase `json:"phase"`
	// Detail is the reason behind a failed or password-needed phase.
	Detail string `json:"detail,omitempty"`
	// Rotations counts how many times the token has been re-issued, so the UI
	// can tell the user to re-scan rather than looking stuck.
	Rotations int `json:"rotations"`
	// Account is filled in once authorised.
	Account string `json:"account,omitempty"`
}

// LoginStarter is the stepped login flow, as opposed to Uploader.Authorise's
// blocking single call. The daemon exposes it over HTTP; the UI drives it.
type LoginStarter interface {
	// BeginLogin starts a scan and returns the first challenge.
	BeginLogin(ctx context.Context) (LoginChallenge, error)
	// PollLogin returns the current state of an attempt.
	PollLogin(ctx context.Context, id string) (LoginChallenge, error)
	// CancelLogin abandons an attempt. Nothing was spent, so this is always safe.
	CancelLogin(id string)
	// Status reports what the transport can do right now.
	Status(ctx context.Context) (Status, error)
}

// loginState is one in-flight attempt, guarded by Telegram.mu.
type loginState struct {
	id     string
	cancel context.CancelFunc

	mu        sync.Mutex
	url       string
	expires   time.Time
	rotations int
	phase     LoginPhase
	detail    string
	account   string
}

func (l *loginState) snapshot() LoginChallenge {
	l.mu.Lock()
	defer l.mu.Unlock()

	c := LoginChallenge{
		ID:          l.id,
		URL:         l.url,
		Rotations:   l.rotations,
		Phase:       l.phase,
		Detail:      l.detail,
		Account:     l.account,
		ExpiresUnix: l.expires.Unix(),
	}
	return c
}

func (l *loginState) setURL(url string, expires time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if url != l.url {
		l.rotations++
	}
	l.url, l.expires = url, expires
	if l.phase == "" {
		l.phase = LoginWaiting
	}
}

func (l *loginState) setPhase(phase LoginPhase, detail string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.phase, l.detail = phase, detail
}

// telegramClient is the slice of the gotd client that login needs.
//
// Naming it rather than importing *telegram.Client keeps this file's
// dependency surface obvious: login talks to QR and to Auth, and nothing else.
type telegramClient interface {
	QR() qrlogin.QR
	Auth() *auth.Client
}

// BeginLogin starts a QR attempt and returns once Telegram has issued a token.
//
// One attempt at a time. Two concurrent scans would share the login-token
// namespace and Telegram invalidates the older one, so the second would look
// like it worked and leave the first hanging.
func (t *Telegram) BeginLogin(ctx context.Context) (LoginChallenge, error) {
	client, err := t.connect(ctx)
	if err != nil {
		return LoginChallenge{}, err
	}

	t.mu.Lock()
	if t.login != nil {
		existing := t.login.snapshot()
		t.mu.Unlock()
		// Re-returning the live attempt is friendlier than an error: a double
		// click on "Connect" should not look like a failure.
		if existing.Phase == LoginWaiting {
			return existing, nil
		}
		return LoginChallenge{}, ErrLoginInProgress
	}

	attemptCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	state := &loginState{id: newLoginID(), cancel: cancel}
	t.login = state
	t.mu.Unlock()

	go t.runLogin(attemptCtx, client, state)

	// Wait for the first token so the caller has something to render. A slow
	// link should not surface as "no QR", and the app can poll regardless.
	deadline := time.After(10 * time.Second)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()

	for {
		snapshot := state.snapshot()
		if snapshot.URL != "" || snapshot.Phase == LoginFailed || snapshot.Phase == LoginAuthorised {
			return snapshot, nil
		}
		select {
		case <-deadline:
			return state.snapshot(), nil
		case <-ctx.Done():
			t.CancelLogin(state.id)
			return LoginChallenge{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

// runLogin drives gotd's QR flow in the background.
//
// The flow is a loop, not a single call: each token lives about 30 seconds, so
// on expiry it exports a fresh one and shows it again. It ends when the phone
// confirms (updateLoginToken, delivered through t.loginSignal) or the caller's
// context is cancelled.
func (t *Telegram) runLogin(ctx context.Context, client telegramClient, state *loginState) {
	finish := func() {
		t.mu.Lock()
		if t.login != nil && t.login.id == state.id {
			t.login = nil
		}
		t.mu.Unlock()
		state.cancel()
	}

	defer func() {
		if r := recover(); r != nil {
			state.setPhase(LoginFailed, fmt.Sprintf("the Telegram login crashed: %v", r))
			finish()
		}
	}()

	_, err := client.QR().Auth(ctx, t.loginSignal, func(_ context.Context, token qrlogin.Token) error {
		state.setURL(token.URL(), token.Expires())
		return nil
	})
	if err != nil {
		t.failLogin(ctx, client, state, err)
		finish()
		return
	}

	// A successful QR login authorises the key the client is already using;
	// there is nothing to import. Refresh the account label so the UI can show
	// who is connected.
	if st, err := client.Auth().Status(ctx); err == nil && st.User != nil {
		state.mu.Lock()
		state.account = accountLabel(st.User)
		state.mu.Unlock()
	}
	state.setPhase(LoginAuthorised, "")
	finish()
}

// failLogin turns an auth error into something a person can act on.
func (t *Telegram) failLogin(ctx context.Context, client telegramClient, state *loginState, err error) {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		state.setPhase(LoginExpired, "the login attempt was cancelled; nothing was sent to Telegram")

	case tgerr.Is(err, "SESSION_PASSWORD_NEEDED"):
		// Two-Step Verification answers the export itself, before any QR is
		// drawn. The scan alone is not enough here, and pretending otherwise
		// would leave the user staring at a code that can never work.
		if t.opts.Password == "" {
			state.setPhase(LoginPasswordNeeded, ErrPasswordRequired.Error())
			return
		}
		if _, pwErr := client.Auth().Password(ctx, t.opts.Password); pwErr != nil {
			state.setPhase(LoginFailed, "Telegram rejected the Two-Step Verification password")
			return
		}
		if st, sErr := client.Auth().Status(ctx); sErr == nil && st.User != nil {
			state.mu.Lock()
			state.account = accountLabel(st.User)
			state.mu.Unlock()
		}
		state.setPhase(LoginAuthorised, "")

	case tgerr.Is(err, "SESSION_REVOKED"), tgerr.Is(err, "AUTH_KEY_UNREGISTERED"):
		state.setPhase(LoginFailed, ErrSessionRevoked.Error())

	case auth.IsUnauthorized(err):
		state.setPhase(LoginFailed, "Telegram will not authorise this session; scan again in a moment")

	default:
		state.setPhase(LoginFailed, err.Error())
	}
}

// PollLogin returns the current state of an attempt.
func (t *Telegram) PollLogin(_ context.Context, id string) (LoginChallenge, error) {
	t.mu.Lock()
	state := t.login
	t.mu.Unlock()

	if state == nil || state.id != id {
		// A finished attempt is reported as expired rather than missing, so a
		// poller that arrives a moment late sees a terminal state instead of a
		// 404 it cannot interpret.
		return LoginChallenge{ID: id, Phase: LoginExpired}, nil
	}
	return state.snapshot(), nil
}

// CancelLogin abandons an attempt.
//
// Always safe: no code was requested and no token was spent on the user's
// phone, so a cancelled scan leaves nothing to clean up on Telegram's side.
func (t *Telegram) CancelLogin(id string) {
	t.mu.Lock()
	state := t.login
	t.mu.Unlock()

	if state == nil || state.id != id {
		return
	}
	state.setPhase(LoginExpired, "cancelled before it was scanned")
	state.cancel()

	t.mu.Lock()
	if t.login == state {
		t.login = nil
	}
	t.mu.Unlock()
}

// newLoginID mints an attempt id. It is not a secret; it only has to be unique
// within one daemon process.
func newLoginID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("login-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}
