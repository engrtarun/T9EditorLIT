package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

// geminiStub answers every generateContent call with a fixed text reply.
func geminiStub(t *testing.T, reply string, status int) (*httptest.Server, func() int) {
	t.Helper()

	var mu sync.Mutex
	calls := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()

		if status != http.StatusOK {
			w.WriteHeader(status)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		body, err := json.Marshal(reply)
		if err != nil {
			t.Errorf("marshal reply: %v", err)
			return
		}
		fmt.Fprintf(w, `{"candidates":[{"content":{"parts":[{"text":%s}]}}]}`, body)
	}))
	t.Cleanup(srv.Close)

	return srv, func() int {
		mu.Lock()
		defer mu.Unlock()
		return calls
	}
}

func segments(n int) []model.Segment {
	out := make([]model.Segment, n)
	for i := range out {
		out[i] = model.Segment{
			ID:        fmt.Sprintf("s%d", i),
			StartSecs: float64(i),
			EndSecs:   float64(i) + 1,
			Text:      fmt.Sprintf("line %d", i),
			Keep:      true,
		}
	}
	return out
}

// TestAnalyzeBatchesLongTranscript is the regression test for "the AI flags
// stop halfway through a long video": every line used to travel in one Gemini
// prompt, so anything past the model's context window was silently never
// judged. Batching makes every line reachable and makes the job's progress
// move in batch-sized steps instead of 0 -> 100.
func TestAnalyzeBatchesLongTranscript(t *testing.T) {
	srv, calls := geminiStub(t, "[]", http.StatusOK)
	client := NewGemini("key", "gemini-2.5-flash", srv.URL)

	lines := segments(AnalysisBatchSize*2 + 10)
	var ticks []int

	got, err := client.AnalyzeProgress(context.Background(), lines, "", "",
		func(done, _ int) { ticks = append(ticks, done) })
	if err != nil {
		t.Fatalf("AnalyzeProgress: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d verdicts, want 0 (the stub keeps everything)", len(got))
	}

	if n := calls(); n != 3 {
		t.Errorf("made %d upstream calls, want 3 batches for %d lines", n, len(lines))
	}
	if want := []int{1, 2, 3}; !reflect.DeepEqual(ticks, want) {
		t.Errorf("progress ticks = %v, want %v", ticks, want)
	}
}

// TestAnalyzeKeepsVerdictsFromHealthyBatches proves a batch failure degrades
// to a partial job instead of throwing away the lines that were judged.
func TestAnalyzeKeepsVerdictsFromHealthyBatches(t *testing.T) {
	var mu sync.Mutex
	fail := true

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		shouldFail := fail
		fail = !fail // alternate: first batch dies, second succeeds
		mu.Unlock()

		if shouldFail {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"message":"boom"}}`))
			return
		}
		_, _ = w.Write([]byte(`{"candidates":[{"content":{"parts":[{"text":"[{\"id\":\"s0\",\"flag\":\"fumble\",\"reason\":\"x\"}]"}]}}]}`))
	}))
	t.Cleanup(srv.Close)

	client := NewGemini("key", "gemini-2.5-flash", srv.URL)
	got, err := client.Analyze(context.Background(), segments(AnalysisBatchSize+1), "", "")

	if err == nil {
		t.Fatal("expected the failed batch to be reported")
	}
	if len(got) == 0 {
		t.Error("verdicts from the healthy batch must survive a partial failure")
	}
}
