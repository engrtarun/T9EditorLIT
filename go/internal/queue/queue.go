// Package queue implements the daemon's bounded worker pool.
//
// It is deliberately bounded. A 2-hour video splits into a few dozen audio
// chunks, and the target machine (8 GB, already ~80% occupied) cannot be asked
// to hold them all in flight. Submit refuses work once capacity is reached and
// the API turns that into HTTP 429, so the caller applies backpressure instead
// of the daemon quietly growing without limit.
package queue

import (
	"context"
	"errors"
	"fmt"
	"math"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// ErrFull is returned by Submit when the queue is at capacity.
var ErrFull = errors.New("queue is at capacity")

// ErrClosed is returned by Submit after Close.
var ErrClosed = errors.New("queue is closed")

// Options configures a Queue.
type Options struct {
	// Workers is the number of concurrent jobs. Keep this small: these are
	// network-bound, not CPU-bound, and each in-flight chunk holds a file
	// handle and a multipart buffer.
	Workers int
	// Capacity is the number of jobs that may wait. Submit blocks once this
	// many are pending and Workers are already busy.
	Capacity int
	// MaxAttempts is the total tries per job, including the first.
	MaxAttempts int
	// BaseBackoff is the first retry delay; it doubles each attempt.
	BaseBackoff time.Duration
	// MaxBackoff caps the exponential growth.
	MaxBackoff time.Duration
	// OnDone is called after a job reaches a terminal state. Optional.
	OnDone func(jobID string, attempts int, err error)
}

func (o *Options) setDefaults() {
	if o.Workers <= 0 {
		o.Workers = 2
	}
	if o.Capacity <= 0 {
		o.Capacity = 32
	}
	if o.MaxAttempts <= 0 {
		o.MaxAttempts = 3
	}
	if o.BaseBackoff <= 0 {
		o.BaseBackoff = time.Second
	}
	if o.MaxBackoff <= 0 {
		o.MaxBackoff = 30 * time.Second
	}
}

// Task is a unit of retryable work.
type Task struct {
	// ID is used for logging and handed to OnDone.
	ID string
	// Run performs the work. Returning a non-nil error triggers a retry when
	// Retryable is true and attempts remain.
	Run func(ctx context.Context) error
	// Retryable marks transient failures (429, 503, network resets) as worth
	// retrying. Permanent failures (400, bad API key) must return false so the
	// daemon does not hammer a provider for a request that can never succeed.
	Retryable bool
}

type item struct {
	task     Task
	attempts int
}

type Queue struct {
	opts Options

	ch   chan *item
	quit chan struct{}
	wg   sync.WaitGroup

	// ctx is the queue's lifetime, not any single job's: it is cancelled by
	// Close so in-flight work stops instead of pinning the daemon open.
	//
	// safeRun used to hand every task a fresh context.Background(), which
	// meant Close could only stop *queued* work. An in-flight Groq/Gemini or
	// Telegram call kept running, main's `defer q.Close()` blocked on
	// q.wg.Wait(), and a shutdown waited out the full cloud call - minutes,
	// not seconds, on a job the user has already abandoned by closing the app.
	// A Task.Run already declares `func(ctx context.Context) error`; it just
	// was never given one worth cancelling.
	ctx    context.Context
	cancel context.CancelFunc

	closeOnce sync.Once

	// onDone is guarded because the HTTP layer attaches its callback AFTER
	// the workers have already started.
	onDoneMu sync.RWMutex
	onDone   func(jobID string, attempts int, err error)

	depth     atomic.Int64
	inFlight  atomic.Int64
	completed atomic.Int64
	failed    atomic.Int64
}

// SetOnDone attaches the completion callback.
//
// Safe to call after New: workers are already running, so the field is
// guarded rather than plain. A nil callback disables notification.
func (q *Queue) SetOnDone(fn func(jobID string, attempts int, err error)) {
	q.onDoneMu.Lock()
	defer q.onDoneMu.Unlock()
	q.onDone = fn
}

// New starts a Queue and its workers.
func New(opts Options) *Queue {
	opts.setDefaults()

	q := &Queue{
		opts:   opts,
		ch:     make(chan *item, opts.Capacity),
		quit:   make(chan struct{}),
		onDone: opts.OnDone, // wired here; SetOnDone may replace it later
	}
	q.ctx, q.cancel = context.WithCancel(context.Background())

	for i := 0; i < opts.Workers; i++ {
		q.wg.Add(1)
		go q.worker()
	}
	return q
}

// Submit enqueues a task.
//
// It never blocks. When the queue is full it returns ErrFull immediately so the
// HTTP layer can answer 429 and the caller can slow down — that backpressure
// is the mechanism that keeps daemon memory flat.
func (q *Queue) Submit(ctx context.Context, t Task) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-q.quit:
		return ErrClosed
	default:
	}

	it := &item{task: t, attempts: 0}

	select {
	case q.ch <- it:
		q.depth.Add(1)
		return nil
	default:
		return fmt.Errorf("%w (capacity %d)", ErrFull, q.opts.Capacity)
	}
}

// worker pulls tasks until the queue is closed and drained.
func (q *Queue) worker() {
	defer q.wg.Done()

	for {
		select {
		case <-q.quit:
			return
		case it := <-q.ch:
			q.depth.Add(-1)
			q.inFlight.Add(1)
			q.run(it)
			q.inFlight.Add(-1)
		}
	}
}

// run executes a task, retrying with exponential backoff when appropriate.
//
// Every attempt is panic-contained. A nil map, a bad type assertion or a
// divide-by-zero inside one job must not take down the daemon: this process
// holds a Telegram session and may have uploads in flight, and an unrecovered
// panic in a worker goroutine terminates the whole program.
func (q *Queue) run(it *item) {
	var lastErr error

	for attempt := 1; attempt <= q.opts.MaxAttempts; attempt++ {
		it.attempts = attempt

		// Honour cancellation between attempts so a closing daemon does not
		// wait out a full backoff window.
		select {
		case <-q.quit:
			q.record(it, lastErr)
			return
		default:
		}

		err, panicked := q.safeRun(it.task)
		if panicked {
			// A panic is a bug, not a transient condition. Do not retry it —
			// retrying a nil-pointer bug just fails three times as slowly.
			q.failed.Add(1)
			q.record(it, err)
			return
		}

		if err == nil {
			q.completed.Add(1)
			q.record(it, nil)
			return
		}

		lastErr = err

		if !it.task.Retryable || attempt == q.opts.MaxAttempts {
			break
		}

		select {
		case <-time.After(q.backoff(attempt)):
		case <-q.quit:
			q.record(it, lastErr)
			return
		}
	}

	q.failed.Add(1)
	q.record(it, lastErr)
}

// safeRun invokes the task and converts a panic into an error.
//
// The context is the queue's, so Close reaches in-flight work: a provider
// call that honours ctx returns as soon as the daemon starts shutting down
// instead of holding q.wg.Wait() open for the rest of the call.
func (q *Queue) safeRun(t Task) (err error, panicked bool) {
	defer func() {
		if rv := recover(); rv != nil {
			// Include the stack: the operator needs to see where it broke.
			err = fmt.Errorf("job panicked: %v\n%s", rv, debug.Stack())
			panicked = true
		}
	}()

	return t.Run(q.ctx), false
}

// backoff returns the delay before the next attempt, doubling each time and
// capped at MaxBackoff so a long outage cannot push retries into the far future.
func (q *Queue) backoff(attempt int) time.Duration {
	shift := attempt - 1
	if shift > 30 {
		shift = 30 // guard the exponent before overflow
	}
	d := time.Duration(float64(q.opts.BaseBackoff) * math.Pow(2, float64(shift)))
	if d > q.opts.MaxBackoff || d <= 0 {
		return q.opts.MaxBackoff
	}
	return d
}

func (q *Queue) record(it *item, err error) {
	q.onDoneMu.RLock()
	fn := q.onDone
	q.onDoneMu.RUnlock()

	if fn != nil {
		fn(it.task.ID, it.attempts, err)
	}
}

// Stats returns a snapshot for the health endpoint.
func (q *Queue) Stats() (depth, capacity, workers, inFlight, completed, failed int) {
	return int(q.depth.Load()),
		q.opts.Capacity,
		q.opts.Workers,
		int(q.inFlight.Load()),
		int(q.completed.Load()),
		int(q.failed.Load())
}

// Close stops the workers. Queued-but-unstarted tasks are abandoned.
//
// Cancel first, then wait: without the cancel, wg.Wait() waits for every
// in-flight provider call to run to completion, and a `t9cloud` in the middle
// of a long transcription would keep the process alive for minutes after the
// user asked it to quit. Tasks that honour the context return immediately;
// ones that do not were never going to stop anyway, so they do not make this
// worse.
func (q *Queue) Close() {
	q.closeOnce.Do(func() {
		close(q.quit)
		if q.cancel != nil {
			q.cancel()
		}
		q.wg.Wait()
	})
}
