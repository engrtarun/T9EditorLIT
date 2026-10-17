package queue

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmitRunsTask(t *testing.T) {
	q := New(Options{Workers: 1, Capacity: 4})
	defer q.Close()

	done := make(chan error, 1)
	if err := q.Submit(context.Background(), Task{
		ID:  "j1",
		Run: func(context.Context) error { done <- nil; return nil },
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("task error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("task never ran")
	}
}

func TestSubmitRetriesRetryableUntilSuccess(t *testing.T) {
	q := New(Options{
		Workers:     1,
		Capacity:    4,
		MaxAttempts: 3,
		BaseBackoff: time.Millisecond,
	})
	defer q.Close()

	var attempts atomic.Int32
	done := make(chan struct{})

	if err := q.Submit(context.Background(), Task{
		ID:        "retry",
		Retryable: true,
		Run: func(context.Context) error {
			if attempts.Add(1) < 3 {
				return errors.New("503 upstream busy")
			}
			close(done)
			return nil
		},
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("expected success on attempt 3, got %d attempts", attempts.Load())
	}
	if got := attempts.Load(); got != 3 {
		t.Fatalf("attempts = %d, want 3", got)
	}
}

func TestSubmitDoesNotRetryNonRetryable(t *testing.T) {
	var attempts atomic.Int32
	errs := make(chan error, 1)

	q := New(Options{
		Workers:     1,
		Capacity:    4,
		MaxAttempts: 5,
		BaseBackoff: time.Millisecond,
		// Set before the workers start — mutating q.opts afterwards would race.
		OnDone: func(_ string, _ int, err error) { errs <- err },
	})
	defer q.Close()

	if err := q.Submit(context.Background(), Task{
		ID:        "fatal",
		Retryable: false,
		Run: func(context.Context) error {
			attempts.Add(1)
			return errors.New("400 bad request")
		},
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("OnDone should receive the failure")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("job never completed")
	}

	if got := attempts.Load(); got != 1 {
		t.Fatalf("non-retryable task ran %d times, want exactly 1", got)
	}
}

func TestSubmitRejectsWhenFull(t *testing.T) {
	// One worker, capacity 1, and a task that blocks. The queue fills and the
	// next Submit must be refused rather than silently buffered.
	release := make(chan struct{})
	q := New(Options{Workers: 1, Capacity: 1})
	defer q.Close()

	blocked := make(chan struct{})
	go func() {
		defer close(blocked)
		_ = q.Submit(context.Background(), Task{
			ID:  "blocker",
			Run: func(context.Context) error { <-release; return nil },
		})
	}()

	// Let the blocker occupy the worker, then fill the single queue slot.
	<-blocked
	deadline := time.Now().Add(time.Second)
	var full bool
	for time.Now().Before(deadline) {
		if q.Submit(context.Background(), Task{ID: "filler", Run: func(context.Context) error { return nil }}) != nil {
			full = true
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	if !full {
		t.Fatal("expected ErrFull once the queue filled up")
	}

	close(release)
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	q := New(Options{BaseBackoff: time.Second, MaxBackoff: 8 * time.Second})
	defer q.Close()

	want := []time.Duration{
		1 * time.Second, // attempt 1
		2 * time.Second, // attempt 2
		4 * time.Second, // attempt 3
		8 * time.Second, // attempt 4
		8 * time.Second, // capped
	}
	for i, w := range want {
		if got := q.backoff(i + 1); got != w {
			t.Errorf("backoff(%d) = %v, want %v", i+1, got, w)
		}
	}
}

func TestPanicInTaskDoesNotKillTheWorker(t *testing.T) {
	q := New(Options{Workers: 1, Capacity: 4, MaxAttempts: 3, BaseBackoff: time.Millisecond})
	defer q.Close()

	errs := make(chan error, 1)
	q.SetOnDone(func(_ string, _ int, err error) { errs <- err })

	var attempts atomic.Int32
	if err := q.Submit(context.Background(), Task{
		ID:        "panicky",
		Retryable: true,
		Run: func(context.Context) error {
			attempts.Add(1)
			var m map[string]string
			m["boom"] = "nil map write" // guaranteed panic
			return nil
		},
	}); err != nil {
		t.Fatalf("Submit: %v", err)
	}

	select {
	case err := <-errs:
		if err == nil {
			t.Fatal("OnDone should receive the panic as an error")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("panicking job never reported back")
	}

	// A panic is a bug, not a transient fault: retrying it would just fail
	// three times as slowly.
	if got := attempts.Load(); got != 1 {
		t.Errorf("panicking task ran %d times, want exactly 1", got)
	}

	// The real point: the worker survived and still accepts new work.
	done := make(chan struct{})
	if err := q.Submit(context.Background(), Task{
		ID:  "after",
		Run: func(context.Context) error { close(done); return nil },
	}); err != nil {
		t.Fatalf("queue dead after a panic: %v", err)
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("worker did not recover — the daemon would have died")
	}
}

func TestStatsReflectsWork(t *testing.T) {
	var wg sync.WaitGroup
	wg.Add(3)

	q := New(Options{
		Workers:     1,
		Capacity:    4,
		MaxAttempts: 1,
		OnDone:      func(string, int, error) { wg.Done() },
	})
	defer q.Close()

	for i := 0; i < 3; i++ {
		if err := q.Submit(context.Background(), Task{
			Run: func(context.Context) error { return nil },
		}); err != nil {
			t.Fatalf("Submit: %v", err)
		}
	}

	wg.Wait()

	_, capacity, workers, _, completed, failed := q.Stats()
	if capacity != 4 {
		t.Errorf("capacity = %d, want 4", capacity)
	}
	if workers != 1 {
		t.Errorf("workers = %d, want 1", workers)
	}
	if completed != 3 {
		t.Errorf("completed = %d, want 3", completed)
	}
	if failed != 0 {
		t.Errorf("failed = %d, want 0", failed)
	}
}
