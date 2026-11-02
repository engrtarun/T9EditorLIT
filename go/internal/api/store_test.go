package api

import (
	"testing"

	"github.com/engrtarun/T9EditorLIT/go/internal/model"
)

func TestSucceedNoSpeechIsAResultNotAFailure(t *testing.T) {
	s := newJobStore()
	j := s.create(model.JobTranscribe, 3)
	s.start(j.ID)
	s.progressTranscribe(j.ID, 3, 0, "")

	s.succeedNoSpeech(j.ID, nil)

	got, ok := s.get(j.ID)
	if !ok {
		t.Fatal("job vanished")
	}
	if !got.NoSpeech {
		t.Error("NoSpeech = false, want true")
	}
	if got.State != model.StateDone {
		t.Errorf("State = %q, want done (no speech is a result, not a failure)", got.State)
	}
	if len(got.Transcript) != 0 {
		t.Errorf("Transcript = %d segments, want none", len(got.Transcript))
	}
	if got.Completed != got.Total {
		t.Errorf("Completed = %d, want total %d", got.Completed, got.Total)
	}
	if got.Lines != 0 {
		t.Errorf("Lines = %d, want 0", got.Lines)
	}
	if got.Error != "" {
		t.Errorf("Error = %q, want empty", got.Error)
	}
}

func TestSucceedNoSpeechKeepsChunkFailures(t *testing.T) {
	s := newJobStore()
	j := s.create(model.JobTranscribe, 2)
	s.start(j.ID)

	// One chunk could not be read; the other was read and held no speech.
	// The job is partial, not failed - there is still a truthful answer.
	s.succeedNoSpeech(j.ID, []string{"chunk2.wav: timeout"})

	got, _ := s.get(j.ID)
	if got.State != model.StatePartial {
		t.Errorf("State = %q, want partial", got.State)
	}
	if got.Error == "" {
		t.Error("Error empty, want the chunk failure carried through")
	}
	if !got.NoSpeech {
		t.Error("NoSpeech = false, want true")
	}
}
