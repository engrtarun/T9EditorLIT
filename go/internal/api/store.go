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
//
// 256 was the wrong number for this machine: a 2-hour job's transcript is a
// slice of segments, and 256 of them were being held resident while the box
// runs at ~1 GB free. The UI shows recent work, not an archive — 64 covers a
// long session (an hour of imports is a handful of jobs) and bounds the
// resident cost to a quarter of what it was.
const maxRetainedJobs = 64

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
//
// Progress counters are reset here because a queue retry re-runs the whole
// task: without the reset a retried job would start at "24/24 chunks" and the
// bar would lie in the opposite direction from the one that made this fix
// necessary.
func (s *jobStore) start(id string) {
	s.mutate(id, func(j *model.Job) {
		j.State = model.StateRunning
		j.Completed = 0
		j.Lines = 0
		j.LastLine = ""
		j.Updated = time.Now().Unix()
	})
}

// setFailedChunks records which chunks a transcribe run could not read.
//
// It is written before the job settles so the terminal payload carries it; the
// retry path needs the indices, and parsing them back out of the human-readable
// error string would couple the client to the daemon's log formatting.
func (s *jobStore) setFailedChunks(id string, indices []int) {
	if len(indices) == 0 {
		return
	}
	s.mutate(id, func(j *model.Job) {
		j.FailedChunks = indices
	})
}

// noteEngine records which engine produced a chunk. The last writer wins:
// mixed jobs carry the most specific name ("elevenlabs+groq+gemini" beats a
// plain fallback), which is the answer a quality question actually needs.
func (s *jobStore) noteEngine(id, engine string) {
	s.mutate(id, func(j *model.Job) {
		j.Engine = engine
	})
}

// advance records progress within a running job.
func (s *jobStore) advance(id string, n int) {
	s.mutate(id, func(j *model.Job) {
		j.Completed += n
		j.Updated = time.Now().Unix()
	})
}

// progressTranscribe records absolute chunk progress plus the live line count.
//
// Absolute rather than incremental on purpose: the transcribe body already
// knows how many chunks it has finished, so setting the value cannot drift the
// way `advance(chunks, len(segments))` did — that mix-up counted segments into
// a total measured in chunks, which showed "400/24" on a two-hour video.
func (s *jobStore) progressTranscribe(id string, chunksDone, lines int, lastLine string) {
	s.mutate(id, func(j *model.Job) {
		j.Completed = chunksDone
		j.Lines = lines
		j.LastLine = lastLine
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
		j.Lines = len(transcript)
		j.Updated = time.Now().Unix()

		if len(failures) > 0 {
			j.State = model.StatePartial
			j.Error = joinErrors(failures)
		} else {
			j.State = model.StateDone
		}
	})
}

// succeedRemux closes a container-repair job.
//
// OutputPath is a NEW file in the user cache. The imported source is never
// modified and never replaced: the user decides whether to import the repaired
// copy, and the project that was already open keeps working either way.
func (s *jobStore) succeedRemux(id, outputPath string) {
	s.mutate(id, func(j *model.Job) {
		j.OutputPath = outputPath
		j.Completed = j.Total
		j.Updated = time.Now().Unix()
		j.State = model.StateDone
	})
}

// succeedNoSpeech closes a transcribe job that found no speech.
//
// This is a success, not a failure. Whisper ran, the audio was read, and the
// honest answer is "there are no words here" - a music-only clip, a sound
// effect, a silent screen recording. The old path returned "every chunk failed"
// for exactly this case, which was untrue and sent the UI down a retry loop
// that could never succeed.
func (s *jobStore) succeedNoSpeech(id string, failures []string) {
	s.mutate(id, func(j *model.Job) {
		j.Transcript = nil
		j.NoSpeech = true
		j.Completed = j.Total
		j.Lines = 0
		j.Updated = time.Now().Unix()

		// Chunks that genuinely errored are still reported: partial means "the
		// parts we read had no speech", failed means "we could not read them".
		if len(failures) > 0 {
			j.State = model.StatePartial
			j.Error = joinErrors(failures)
		} else {
			j.State = model.StateDone
		}
	})
}

// succeedMusic closes a transcribe job whose audio turned out to be music.
//
// It is a different answer from "no speech", and the app needs to tell them
// apart. "No speech" on a silent clip means nothing happened. "Music" on a
// track means the waveform is the right instrument for this project and a
// transcript is not - so the app switches to waveform-first editing instead
// of showing an empty transcript panel and a retry button.
func (s *jobStore) succeedMusic(id string, failures []string) {
	s.mutate(id, func(j *model.Job) {
		j.Transcript = nil
		j.NoSpeech = true
		j.Music = true
		j.Completed = j.Total
		j.Lines = 0
		j.Updated = time.Now().Unix()

		if len(failures) > 0 {
			j.State = model.StatePartial
			j.Error = joinErrors(failures)
		} else {
			j.State = model.StateDone
		}
	})
}

// setAudioProfile records the local measurement of the source's audio.
func (s *jobStore) setAudioProfile(id string, profile *model.AudioProfile) {
	if profile == nil {
		return
	}
	s.mutate(id, func(j *model.Job) {
		j.AudioProfile = profile
	})
}

// setLanguage records the language the job settled on, and why it might not
// be right.
func (s *jobStore) setLanguage(id, language, warning string) {
	if language == "" && warning == "" {
		return
	}
	s.mutate(id, func(j *model.Job) {
		j.Language = language
		j.LanguageWarning = warning
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

// succeedTranslate attaches a translated transcript.
//
// The lines are the same lines: only TranslatedText was added, and the
// source text is untouched. A batch that failed keeps its source text, so a
// partial translation is still a usable transcript.
func (s *jobStore) succeedTranslate(id string, translated []model.Segment, failures []string) {
	s.mutate(id, func(j *model.Job) {
		j.Translated = translated
		j.Completed = j.Total
		j.Lines = len(translated)
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

// finishRestore records a restore outcome: where the file landed and what it
// took to put it back.
//
// Destination carries the path the app adds to the media library; an upload
// leaves it empty. MessageIDs stay nil — the ids belong to the upload that
// created this manifest, not to any send this job made.
func (s *jobStore) finishRestore(id, chat string, totalBytes int64, dest string, partCount int) {
	s.mutate(id, func(j *model.Job) {
		j.VaultResult = &model.VaultResult{
			ChatID:      chat,
			PartCount:   partCount,
			TotalBytes:  totalBytes,
			Destination: dest,
			CompletedAt: time.Now().Unix(),
		}
		if j.VaultProgress != nil {
			j.VaultProgress.Phase = "done"
			j.VaultProgress.BytesDone = totalBytes
			j.VaultProgress.PartsDone = partCount
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
