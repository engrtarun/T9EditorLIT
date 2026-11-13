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
	JobCorrect    JobKind = "correct"
	JobAnalyze    JobKind = "analyze"
	JobVault      JobKind = "vault"

	// JobTranslate renders an existing transcript in a second language.
	//
	// It is a separate pass because it is optional and because it must not
	// touch the source text: the translation travels beside the original, in
	// its own field, and the user cuts on what was said.
	JobTranslate JobKind = "translate"

	// JobRemux is a lossless container repair (stream copy, no re-encode).
	//
	// It is a job rather than a synchronous call because a 5 GB file is
	// disk-bound: the UI keeps its progress row and the daemon is not blocked
	// for a minute. The result is a path in the user cache, never a silent
	// replacement of the imported file.
	JobRemux JobKind = "remux"

	// JobRestore is the read half of the vault: the daemon streams a backed-up
	// file back out of Telegram, verifies part by part against the digests
	// the upload recorded, and joins the parts into one file on disk. It
	// reports the same VaultProgress payload an upload uses.
	JobRestore JobKind = "restore"
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
// Word is one word with its own timing, straight out of Whisper.
//
// This is what lets the editor split a line's *text* as well as its timeline:
// cutting "I LOVE U" after 4 s can then yield "I" and "LOVE U" instead of two
// rows that both read "I LOVE U".
type Word struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

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
	// OriginalText is the pre-autocorrect Whisper output for this line.
	//
	// Set ONLY when autocorrect actually changed something — a line that came
	// through untouched leaves it empty. That distinction is what lets the UI
	// show "this was fixed" without claiming every line was.
	OriginalText string `json:"original_text,omitempty"`
	// Words is the word-level timing for this line, when Whisper produced it.
	//
	// Absent means "no word alignment" - the editor then splits the line's
	// time but not its text. Present, the split cuts the text too.
	Words []Word `json:"words,omitempty"`
	// Language is the ISO-639-1 code of the language this line was decoded
	// as, when the provider reported one.
	//
	// It is a *badge*, not a decision: a travel vlog that switches between
	// twelve languages gets twelve badges, and the user can see the switch
	// instead of wondering why the script changed mid-sentence. Empty means
	// the provider did not say.
	Language string `json:"language,omitempty"`
	// TranslatedText is the line rendered in another language.
	//
	// The source text stays in Text — always. A translation is a second
	// view of the same line, never a replacement: the user cuts on what was
	// said, not on what it was translated into.
	TranslatedText string `json:"translated_text,omitempty"`
	// TranslationSource names the provider that produced TranslatedText
	// ("gemini", "groq"), so the UI can label the badge honestly.
	TranslationSource string `json:"translation_source,omitempty"`
	// Protected marks a line the user has pinned as "never cut this".
	//
	// It is the escape hatch for every detector that cannot be trusted: an
	// ASMR whisper, a crosstalk overlap, a hook the detector reads as
	// silence. Auto-cut skips protected lines; nothing else does.
	Protected bool `json:"protected,omitempty"`

	// Tags are the non-speech bracket labels Whisper emitted in this line:
	// "music", "applause", "laughter", "silence", ...
	//
	// They are kept as data, not deleted from Text: the tags are the model's
	// useful signal that this region is not speech, and the UI can render an
	// icon instead of showing the user "[Music]" in the cut list.
	Tags []string `json:"tags,omitempty"`

	// Repeated marks a line that repeats an earlier line verbatim over
	// non-speech audio (Whisper's stock-phrase loop, case 24).
	//
	// Its text is still here - the UI collapses the run and shows "(xN)";
	// nothing is silently thrown away.
	Repeated bool `json:"repeated,omitempty"`
	// RepeatOf is the id of the line this one repeats.
	RepeatOf string `json:"repeat_of,omitempty"`
	// RepeatCount is set on the first line of a loop: how many copies the run
	// held. Zero means "not a loop".
	RepeatCount int `json:"repeat_count,omitempty"`
	// RepeatKind classifies a repetition:
	//
	//   "loop"        - three or more identical lines over a long gap (a
	//                   hallucination, safe to collapse)
	//   "restatement" - a retake that added words (the second version is the
	//                   one the speaker meant; case 26)
	//   "fumble"      - a retake that lost words
	//
	// Only "loop" is safe to pre-decide. The other two are suggestions and
	// always require the user's confirmation.
	RepeatKind string `json:"repeat_kind,omitempty"`

	// Crosstalk marks a line whose words overlap another line's words in
	// time. Two voices at once is never auto-cut (case 22): the detector
	// cannot know which speaker the user wants.
	Crosstalk bool `json:"crosstalk,omitempty"`

	// NeedsConfirm means the automated pass found something but deliberately
	// did not decide it. The UI shows a confirm action instead of a
	// pre-selected cut.
	NeedsConfirm bool `json:"needs_confirm,omitempty"`

	// LexiconHits lists the creator-vocabulary terms this line was corrected
	// with (case 39). Text holds the corrected spelling; OriginalText holds
	// the raw Whisper output when it changed.
	LexiconHits []string `json:"lexicon_hits,omitempty"`
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
	// Sensitivity is how eager the local gate is to call a pause silence:
	// "conservative", "balanced" or "aggressive". Empty means balanced.
	//
	// It travels with the job so the daemon measures the file with the same
	// dial the user picked in the UI - one measurement, one threshold, and
	// the cut map and the upload gate agree about what "silence" means.
	Sensitivity string `json:"sensitivity,omitempty"`
}

// AudioProfile is what one local measurement pass says about a source's
// audio.
//
// Every number here comes from the same scan of the same 16 kHz mono chunks
// the transcription uses (see internal/vad). Nothing is decoded twice and
// nothing is uploaded to measure it: the noise floor, the speech level, the
// ratio between them and the share of the file that is not dead air are all
// free, local facts.
//
// The UI shows them and the cut map uses them, which is what keeps the
// editor and the transcriber from disagreeing about the same file.
type AudioProfile struct {
	// DurationSecs is the length of the audio that was measured.
	DurationSecs float64 `json:"duration_secs"`
	// AudibleSecs is how much of it is louder than the threshold.
	AudibleSecs float64 `json:"audible_secs"`
	// SpeechRatio is AudibleSecs / DurationSecs, 0..1.
	SpeechRatio float64 `json:"speech_ratio"`
	// NoiseFloorDB is the measured room tone, in dBFS.
	NoiseFloorDB float64 `json:"noise_floor_db"`
	// SpeechDB is the measured speech level, in dBFS.
	SpeechDB float64 `json:"speech_db"`
	// SNRDB is SpeechDB - NoiseFloorDB: how far the voice sits above the
	// background. Under about 8 dB the voice is fighting the music bed.
	SNRDB float64 `json:"snr_db"`
	// PeakDB is the loudest moment in the file, in dBFS.
	PeakDB float64 `json:"peak_db"`
	// ThresholdDB is the level a frame has to clear to count as sound.
	ThresholdDB float64 `json:"threshold_db"`
	// MarginDB is how far above the noise floor that threshold sits.
	MarginDB float64 `json:"margin_db"`
	// Sensitivity is the dial that produced these numbers.
	Sensitivity string `json:"sensitivity"`
	// SilenceThresholdDB is what the cut map should use instead of a fixed
	// -30 dB: the same bar, measured for this file.
	SilenceThresholdDB float64 `json:"silence_threshold_db"`
	// Chunks is how many chunks the profile covers, and Measured is how many
	// of them could actually be read. A profile built from three of ten
	// chunks is a sample, and the UI says so.
	Chunks   int `json:"chunks"`
	Measured int `json:"measured"`
}

// TranslateRequest asks for a second-language rendering of a transcript.
//
// The source text is never replaced: the reply carries a translation per
// line, and the app shows it under the original.
type TranslateRequest struct {
	SourcePath string    `json:"source_path"`
	Segments   []Segment `json:"segments"`
	// Target is the language to translate into ("en" by default).
	Target string `json:"target,omitempty"`
}

// CorrectRequest asks for Whisper's spelling to be cleaned up.
//
// It runs between transcription and analysis, because the analyser judges what
// was *said* — feeding it phonetically broken text makes its verdicts worse.
type CorrectRequest struct {
	SourcePath string    `json:"source_path"`
	Segments   []Segment `json:"segments"`
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

	// Lines is how many transcript lines exist SO FAR. It answers the question
	// a progress bar cannot: "is it actually producing text, or just spinning?"
	//
	// Completed counts chunks (the unit the job advertised); a chunk can yield
	// forty lines or none, so lines and completed are different numbers and
	// both are shown.
	Lines int `json:"lines,omitempty"`
	// LastLine is the tail of the newest transcript line, so the UI can show
	// live text instead of a bar that has not moved in a minute.
	LastLine string `json:"last_line,omitempty"`

	// Error carries the human-readable failure reason when State is failed.
	Error string `json:"error,omitempty"`

	// FailedChunks lists the chunk indices a partial transcribe job could not
	// read. The app uses it to retry exactly those chunks: a 49-minute import
	// that lost chunk 3 must not pay Whisper for chunks 0-2 and 4-9 again.
	//
	// Indices, not ranges or file names: the caller already has the ordered
	// chunk list with its offsets, so an index is the one value that survives
	// a different temp directory and a re-extraction.
	FailedChunks []int `json:"failed_chunks,omitempty"`

	// NoSpeech means the audio contained no actual speech: Whisper's output was
	// filtered as non-speech or was nothing but its stock sign-off phrases.
	// Transcript is empty and the job still succeeded - "no words here" is a
	// result, not a failure, and the UI must not offer a pointless retry loop.
	NoSpeech bool `json:"no_speech,omitempty"`

	// Engine names what actually produced this transcript — "elevenlabs",
	// "groq", or "elevenlabs+groq+gemini" for a reconciled ensemble chunk.
	// Telemetry, not control: the UI records it with the job's outcome so a
	// quality question has something to point at.
	Engine string `json:"engine,omitempty"`

	// Music means the audio is music, not speech: the file carries sound but
	// no words.
	//
	// The distinction matters because the two have different answers. "No
	// speech" on a silent clip means nothing happened. "Music" on a track
	// means the waveform is the right tool for this project and a transcript
	// is not - the app says so instead of showing an empty transcript panel.
	Music bool `json:"music,omitempty"`

	// Language is the ISO-639-1 code the job settled on, and
	// LanguageWarning explains why it might not be right.
	//
	// The daemon pins the language once two chunks agree on it, then
	// cross-checks the script the text came back in. When those disagree -
	// an accented English speaker detected as Hindi, a Hinglish line in
	// Devanagari pinned to English - the job still finishes, but it says so.
	Language        string `json:"language,omitempty"`
	LanguageWarning string `json:"language_warning,omitempty"`

	// AudioProfile is the local measurement of the source's audio.
	//
	// It is filled in for a transcribe job and can be fetched on its own,
	// because the cut map wants it *before* the transcription starts.
	AudioProfile *AudioProfile `json:"audio_profile,omitempty"`

	// OutputPath is the file a repair job produced (remux). It is a new file
	// in the user cache; the imported source is never modified.
	OutputPath string `json:"output_path,omitempty"`

	// Transcript is populated for transcribe jobs.
	Transcript []Segment `json:"transcript,omitempty"`
	// Corrected is populated for correct jobs — the same lines with their
	// spelling fixed and OriginalText filled in where the text changed.
	Corrected []Segment `json:"corrected,omitempty"`
	// Translated is populated for translate jobs — the same lines with a
	// TranslatedText beside each one. The source text is untouched.
	Translated []Segment `json:"translated,omitempty"`
	// Analysis is populated for analyze jobs.
	Analysis []Segment `json:"analysis,omitempty"`
	// VaultResult describes the upload outcome for vault jobs.
	VaultResult *VaultResult `json:"vault_result,omitempty"`
	// VaultProgress is the live state of an upload, including the byte-level
	// detail a 5 GB transfer needs. Three parts is a useless progress bar;
	// bytes and a rate are what the user actually reads.
	VaultProgress *VaultProgress `json:"vault_progress,omitempty"`
}

// Progress returns 0.0–1.0 completion, or 0 when the job has no total yet.
//
// Vault jobs prefer bytes: their unit is 1.9 GB per part, so counting parts
// would show 33% for a quarter of an hour and then jump to done.
func (j *Job) Progress() float64 {
	if (j.Kind == JobVault || j.Kind == JobRestore) && j.VaultProgress != nil && j.VaultProgress.BytesTotal > 0 {
		return float64(j.VaultProgress.BytesDone) / float64(j.VaultProgress.BytesTotal)
	}
	if j.Total <= 0 {
		return 0
	}
	return float64(j.Completed) / float64(j.Total)
}

// VaultProgress is one snapshot of a running upload.
type VaultProgress struct {
	// Phase is "hashing", "uploading" or "done".
	Phase string `json:"phase"`
	// PartsDone out of PartCount.
	PartsDone int `json:"parts_done"`
	PartCount int `json:"part_count"`
	PartIndex int `json:"part_index"`
	// BytesDone out of BytesTotal, hashed or sent so far.
	BytesDone   int64   `json:"bytes_done"`
	BytesTotal  int64   `json:"bytes_total"`
	BytesPerSec float64 `json:"bytes_per_sec"`
	// Connections is how many TCP sockets are carrying the bytes at once.
	Connections int `json:"connections"`
	// Message is a short note for the UI.
	Message string `json:"message,omitempty"`
}

// VaultResult reports where a file landed in Telegram.
type VaultResult struct {
	ChatID      string `json:"chat_id"`
	MessageIDs  []int  `json:"message_ids"`
	PartCount   int    `json:"part_count"`
	TotalBytes  int64  `json:"total_bytes"`
	CompletedAt int64  `json:"completed_unix"`

	// Destination is the on-disk path of the restored file, set only by
	// vault download jobs. An upload leaves it empty.
	Destination string `json:"destination,omitempty"`
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
