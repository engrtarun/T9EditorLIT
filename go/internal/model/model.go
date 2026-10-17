// Package model holds the types that cross the HTTP boundary between the
// Tauri desktop app and this daemon.
//
// Field names are snake_case in Go because they are serialised straight to
// JSON for the frontend, which expects the snake_case that the Rust side
// writes into SQLite.
package model

// JobKind identifies which pipeline a job belongs to.
type JobKind string

const (
	JobTranscribe JobKind = "transcribe"
	JobAnalyze    JobKind = "analyze"
	JobVault      JobKind = "vault"
)

// JobState is the lifecycle of a job. Anything terminal will not change again.
type JobState string

const (
	StateQueued  JobState = "queued"
	StateRunning JobState = "running"
	StateDone    JobState = "done"
	StateFailed  JobState = "failed"
	StatePartial JobState = "partial"
)

// Terminal reports whether the job has stopped moving.
func (s JobState) Terminal() bool {
	return s == StateDone || s == StateFailed || s == StatePartial
}

// Flag is why the analyser marked a transcript line for cutting. These map
// directly onto the ✕ marks in the Cut Panel.
type Flag string

const (
	FlagNone         Flag = "none"
	FlagSilence      Flag = "silence"
	FlagFumble       Flag = "fumble"
	FlagRetake       Flag = "retake"
	FlagWrongExample Flag = "wrong_example"
)

// Valid reports whether f is a flag the UI knows how to render.
func (f Flag) Valid() bool {
	switch f {
	case FlagNone, FlagSilence, FlagFumble, FlagRetake, FlagWrongExample:
		return true
	default:
		return false
	}
}

// Segment is one transcript line.
//
// Times are absolute seconds in the ORIGINAL video, never chunk-local. The
// daemon offsets each chunk's response by that chunk's start time before
// returning, so the app never has to think about chunk boundaries.
type Segment struct {
	ID        string  `json:"id"`
	StartSecs float64 `json:"start_secs"`
	EndSecs   float64 `json:"end_secs"`
	Text      string  `json:"text"`
	Flag      Flag    `json:"flag"`
	// Keep mirrors the ✓/✕ decision. Defaults true; the analyser sets false
	// for anything it believes should be cut.
	Keep bool `json:"keep"`
	// Reason is free-text justification shown on hover in the UI.
	Reason string `json:"reason,omitempty"`
}

// Duration returns the segment length in seconds, never negative.
func (s Segment) Duration() float64 {
	d := s.EndSecs - s.StartSecs
	if d < 0 {
		return 0
	}
	return d
}

// ChunkRequest is one audio slice the app already wrote to disk.
//
// The daemon deliberately never receives a video path, and never buffers audio
// itself — the Rust side extracts and splits, then hands over file paths. That
// keeps the "no large payload in RAM" rule intact across the process boundary.
type ChunkRequest struct {
	// Path to a ≤25 MB audio chunk on local disk.
	Path string `json:"path"`
	// OffsetSecs is where this chunk starts in the original video.
	OffsetSecs float64 `json:"offset_secs"`
	// Index is the chunk's position in the ordered split.
	Index int `json:"index"`
}

// TranscribeRequest asks for a transcript of a list of audio chunks.
type TranscribeRequest struct {
	SourcePath string         `json:"source_path"`
	Chunks     []ChunkRequest `json:"chunks"`
	// Language hint forwarded to Whisper. Empty lets the model decide.
	Language string `json:"language,omitempty"`
	// Prompt biases Whisper toward Hinglish tech vocabulary.
	Prompt string `json:"prompt,omitempty"`
}

// AnalyzeRequest asks Gemini to flag retakes and wrong examples.
type AnalyzeRequest struct {
	SourcePath string    `json:"source_path"`
	Segments   []Segment `json:"segments"`
	// ToneProfile is a short description of how the creator speaks, used to
	// tell an intentional restatement apart from a genuine fumble.
	ToneProfile string `json:"tone_profile,omitempty"`
	// CreatorHandle e.g. "@EngrTarunDilwal", recorded for provenance.
	CreatorHandle string `json:"creator_handle,omitempty"`
}

// Job is the unit the queue tracks and the API reports on.
type Job struct {
	ID      string   `json:"id"`
	Kind    JobKind  `json:"kind"`
	State   JobState `json:"state"`
	Created int64    `json:"created_unix"`
	Updated int64    `json:"updated_unix"`

	Total     int `json:"total"`
	Completed int `json:"completed"`

	// Error carries the human-readable failure reason when State is failed.
	Error string `json:"error,omitempty"`

	// Transcript is populated for transcribe jobs.
	Transcript []Segment `json:"transcript,omitempty"`
	// Analysis is populated for analyze jobs.
	Analysis []Segment `json:"analysis,omitempty"`
	// VaultResult describes the upload outcome for vault jobs.
	VaultResult *VaultResult `json:"vault_result,omitempty"`
}

// Progress returns 0.0–1.0 completion, or 0 when the job has no total yet.
func (j *Job) Progress() float64 {
	if j.Total <= 0 {
		return 0
	}
	return float64(j.Completed) / float64(j.Total)
}

// VaultResult reports where a file landed in Telegram.
type VaultResult struct {
	ChatID      string `json:"chat_id"`
	MessageIDs  []int  `json:"message_ids"`
	PartCount   int    `json:"part_count"`
	TotalBytes  int64  `json:"total_bytes"`
	CompletedAt int64  `json:"completed_unix"`
}

// Health is the payload of GET /healthz.
type Health struct {
	OK      bool              `json:"ok"`
	Version string            `json:"version"`
	Uptime  int64             `json:"uptime_secs"`
	Queue   QueueHealth       `json:"queue"`
	Cloud   map[string]string `json:"cloud"`
}

// QueueHealth exposes queue depth so the app can warn before submitting more
// work than the daemon can hold.
type QueueHealth struct {
	Depth     int  `json:"depth"`
	Capacity  int  `json:"capacity"`
	Workers   int  `json:"workers"`
	Blocked   bool `json:"blocked"`
	InFlight  int  `json:"in_flight"`
	Completed int  `json:"completed"`
	Failed    int  `json:"failed"`
}
