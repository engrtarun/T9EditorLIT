package api

import (
	"sync"
	"time"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
	"github.com/engrtarun/T9EditorLIT/go/internal/vault"
)

// maxRetainedJobs caps the in-memory job history.
//
// Jobs hold transcripts, so keeping every job from a long editing session
// forever would grow without bound — exactly the leak this project exists to
// avoid. The oldest job is dropped past this limit; the desktop app persists
// what it cares about into SQLite as soon as it fetches a result.
const maxRetainedJobs = 256

// jobStore is a concurrency-safe map of job state.
//
// Ordering matters here: create sets a fresh job, the worker updates it in
// place, and the HTTP layer reads snapshots. Every mutation goes through the
// mutex, and reads return a deep copy so a caller iterating a transcript
// cannot trip a concurrent update.
type jobStore struct {
	mu   sync.RWMutex
	jobs map[string]*model.Job
	// order preserves insertion order for eviction.
	order []string
}

func newJobStore() *jobStore {
	return &jobStore{jobs: make(map[string]*model.Job, maxRetainedJobs)}
}

func (s *jobStore) create(kind model.JobKind, total int) *model.Job {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	j := &model.Job{
		ID:      newID(),
		Kind:    kind,
		State:   model.StateQueued,
		Created: now,
		Updated: now,
		Total:   total,
	}

	s.jobs[j.ID] = j
	s.order = append(s.order, j.ID)
	s.evictLocked()

	return cloneJob(j)
}

// start marks a job as running.
func (s *jobStore) start(id string) {
	s.mutate(id, func(j *model.Job) {
		j.State = model.StateRunning
		j.Updated = time.Now().Unix()
	})
}

// advance records progress within a running job.
func (s *jobStore) advance(id string, n int) {
	s.mutate(id, func(j *model.Job) {
		j.Completed += n
		j.Updated = time.Now().Unix()
	})
}

// succeed attaches results and marks the job done.
//
// A non-empty failures slice downgrades the job to StatePartial: the user got
// most of the work, and saying "failed" would throw that away.
func (s *jobStore) succeed(id string, transcript, analysis []model.Segment, failures []string) {
	s.mutate(id, func(j *model.Job) {
		j.Transcript = transcript
		if analysis != nil {
			j.Analysis = analysis
		}
		j.Completed = j.Total
		j.Updated = time.Now().Unix()

		if len(failures) > 0 {
			j.State = model.StatePartial
			j.Error = joinErrors(failures)
		} else {
			j.State = model.StateDone
		}
	})
}

// succeedCorrect attaches an autocorrected transcript.
//
// Like succeed, a non-empty failures slice downgrades to StatePartial: most
// batches corrected fine, and the rest simply kept Whisper's spelling, which is
// a working transcript rather than a failure.
func (s *jobStore) succeedCorrect(id string, corrected []model.Segment, failures []string) {
	s.mutate(id, func(j *model.Job) {
		j.Corrected = corrected
		j.Completed = j.Total
		j.Updated = time.Now().Unix()

		if len(failures) > 0 {
			j.State = model.StatePartial
			j.Error = joinErrors(failures)
		} else {
			j.State = model.StateDone
		}
	})
}

// finish is the queue's OnDone hook. It is the single place a job reaches a
// terminal state from the worker side.
func (s *jobStore) finish(id string, _ int, err error) {
	if err == nil {
		return // success paths call succeed() themselves, with their payloads
	}
	s.fail(id, err)
}

// fail marks a job failed with a human-readable reason.
func (s *jobStore) fail(id string, err error) {
	s.mutate(id, func(j *model.Job) {
		j.State = model.StateFailed
		j.Error = err.Error()
		j.Updated = time.Now().Unix()
	})
}

// progressVault records the live state of an upload.
//
// Byte-level rather than part-level on purpose: an upload is three parts of
// 1.9 GB each, so counting parts shows 33% for a quarter of an hour and then
// snaps to done. The rate is kept too, because "12 minutes left" is the number
// a person actually wants while a backup runs.
func (s *jobStore) progressVault(id string, p vault.Progress) {
	s.mutate(id, func(j *model.Job) {
		j.Completed = p.PartsDone
		j.VaultProgress = &model.VaultProgress{
			Phase:       p.Phase,
			PartsDone:   p.PartsDone,
			PartCount:   p.PartCount,
			PartIndex:   p.PartIndex,
			BytesDone:   p.BytesDone,
			BytesTotal:  p.BytesTotal,
			BytesPerSec: p.BytesPerSec,
			Connections: p.Connections,
			Message:     p.Message,
		}
		j.Updated = time.Now().Unix()
	})
}

// finishVault records an upload outcome.
func (s *jobStore) finishVault(id, chat string, parts []vault.Part, ids []int, totalBytes int64) {
	s.mutate(id, func(j *model.Job) {
		j.VaultResult = &model.VaultResult{
			ChatID:      chat,
			MessageIDs:  ids,
			PartCount:   len(parts),
			TotalBytes:  totalBytes,
			CompletedAt: time.Now().Unix(),
		}
		if j.VaultProgress != nil {
			j.VaultProgress.Phase = "done"
			j.VaultProgress.BytesDone = totalBytes
			j.VaultProgress.PartsDone = len(parts)
		}
		j.Completed = j.Total
		j.State = model.StateDone
		j.Updated = time.Now().Unix()
	})
}

func (s *jobStore) get(id string) (model.Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	j, ok := s.jobs[id]
	if !ok {
		return model.Job{}, false
	}
	return *cloneJob(j), true
}

// mutate applies fn to a job under the write lock, skipping unknown ids.
func (s *jobStore) mutate(id string, fn func(*model.Job)) {
	s.mu.Lock()
	defer s.mu.Unlock()

	j, ok := s.jobs[id]
	if !ok {
		return
	}
	fn(j)
}

// evictLocked drops the oldest jobs past the retention limit.
// Caller must hold the write lock.
func (s *jobStore) evictLocked() {
	for len(s.order) > maxRetainedJobs {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.jobs, oldest)
	}
}

// cloneJob deep-copies the slices so callers cannot mutate stored state and so
// the store never hands out a slice that a worker is still appending to.
func cloneJob(j *model.Job) *model.Job {
	c := *j
	if j.Transcript != nil {
		c.Transcript = append([]model.Segment(nil), j.Transcript...)
	}
	if j.Corrected != nil {
		c.Corrected = append([]model.Segment(nil), j.Corrected...)
	}
	if j.Analysis != nil {
		c.Analysis = append([]model.Segment(nil), j.Analysis...)
	}
	if j.VaultResult != nil {
		v := *j.VaultResult
		v.MessageIDs = append([]int(nil), j.VaultResult.MessageIDs...)
		c.VaultResult = &v
	}
	if j.VaultProgress != nil {
		p := *j.VaultProgress
		c.VaultProgress = &p
	}
	return &c
}

func joinErrors(ss []string) string {
	out := ""
	for i, s := range ss {
		if i > 0 {
			out += "; "
		}
		out += s
	}
	return out
}
