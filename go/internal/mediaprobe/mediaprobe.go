// Package mediaprobe is the import gate: one ffprobe pass over the source that
// answers the questions the editor would otherwise discover halfway through a
// project.
//
// The playbook's Group F and G cases (27-38) are all the same shape: the file
// is technically readable, but something about its container, timing, colour
// metadata or encode history will bite later. Discovering that after the user
// has spent twenty minutes cutting is the expensive failure. One local
// measurement at import time front-loads it, costs zero API calls and never
// touches the original bytes.
//
// This package deliberately runs `ffprobe`/`ffmpeg` as child processes and
// reads only small, bounded outputs. It never decodes a whole video into RAM:
// the layout pass samples a handful of seeked frames at 96x54 greyscale, and
// remux is a stream copy (`-c copy`) that moves bytes without decoding them.
package mediaprobe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Issue codes are stable strings: the UI groups and colours by them, and the
// documentation refers to them. Never translate a code; translate the text.
const (
	CodeAudioOnly      = "audio_only"
	CodeNoAudio        = "no_audio"
	CodeVFR            = "vfr"
	CodeColorMetadata  = "color_metadata"
	CodeAVOffset       = "av_offset"
	CodeBloat          = "bloat"
	CodeDurationSplit  = "duration_split"
	CodeProbeFailed    = "probe_failed"
	CodeLongSource     = "long_source"
	CodeLowFPS         = "low_fps"
	CodeStaticOverlay  = "static_overlay"
	CodeBusyCorner     = "busy_corner"
	CodePortraitSource = "portrait_source"
)

// Severity tells the UI how loud the chip should be.
//
//   - info: worth knowing, nothing to do
//   - warn: a real risk, but the project still works
//   - action: a one-click repair exists (remux) or a setting to check
type Severity string

const (
	SeverityInfo   Severity = "info"
	SeverityWarn   Severity = "warn"
	SeverityAction Severity = "action"
)

// Issue is one finding about the source file.
type Issue struct {
	Code     string   `json:"code"`
	Severity Severity `json:"severity"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	// Fix is what the user can do, in one sentence. Empty means "nothing".
	Fix string `json:"fix,omitempty"`
	// Action names a machine-repair the UI may offer:
	// "remux" is the only one implemented today.
	Action string `json:"action,omitempty"`
}

// VideoStream is the part of ffprobe's stream record this gate needs.
type VideoStream struct {
	Index          int     `json:"index"`
	Codec          string  `json:"codec"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	PixelFormat    string  `json:"pixel_format,omitempty"`
	FPS            float64 `json:"fps"`
	AvgFrameRate   string  `json:"avg_frame_rate,omitempty"`
	RFrameRate     string  `json:"r_frame_rate,omitempty"`
	ColorRange     string  `json:"color_range,omitempty"`
	ColorSpace     string  `json:"color_space,omitempty"`
	ColorTransfer  string  `json:"color_transfer,omitempty"`
	ColorPrimaries string  `json:"color_primaries,omitempty"`
	StartSecs      float64 `json:"start_secs"`
	DurationSecs   float64 `json:"duration_secs"`
	BitRateBps     int64   `json:"bit_rate_bps,omitempty"`
	Frames         int64   `json:"frames,omitempty"`
}

// AudioStream is the audio half of the same record.
type AudioStream struct {
	Index        int     `json:"index"`
	Codec        string  `json:"codec"`
	SampleRate   int     `json:"sample_rate"`
	Channels     int     `json:"channels"`
	BitRateBps   int64   `json:"bit_rate_bps,omitempty"`
	StartSecs    float64 `json:"start_secs"`
	DurationSecs float64 `json:"duration_secs"`
}

// Bloat is the "5.3 GB for a screen recording" finding (case 31).
type Bloat struct {
	ActualBitrateBps  int64   `json:"actual_bitrate_bps"`
	TargetBitrateBps  int64   `json:"target_bitrate_bps"`
	TargetBytes       int64   `json:"target_bytes"`
	SavingsBytes      int64   `json:"savings_bytes"`
	SavingsPercent    float64 `json:"savings_percent"`
	BytesPerMinute    int64   `json:"bytes_per_minute"`
	AssumedBitsPerPix float64 `json:"assumed_bits_per_pixel"`
}

// AVIssue carries the measured offset so the UI can show the number, not just
// a sentence (case 30).
type AVIssue struct {
	OffsetSecs float64 `json:"offset_secs"`
	AudioStart float64 `json:"audio_start_secs"`
	VideoStart float64 `json:"video_start_secs"`
}

// Report is the whole gate answer for one file.
type Report struct {
	Path         string  `json:"path"`
	Container    string  `json:"container,omitempty"`
	DurationSecs float64 `json:"duration_secs"`
	SizeBytes    int64   `json:"size_bytes"`
	BitRateBps   int64   `json:"bit_rate_bps"`

	Video *VideoStream `json:"video,omitempty"`
	Audio *AudioStream `json:"audio,omitempty"`

	HasAudio  bool `json:"has_audio"`
	AudioOnly bool `json:"audio_only,omitempty"`
	Portrait  bool `json:"portrait,omitempty"`

	// VFR is true when the average and nominal frame rates are not the same
	// rational. Frame-index maths is wrong on these files; time-based (PTS)
	// seeking is not (case 32).
	VFR bool `json:"vfr,omitempty"`

	// AVOffsetSecs is audio start minus video start. Positive means the audio
	// begins later than the picture (case 30).
	AVOffsetSecs float64 `json:"av_offset_secs,omitempty"`

	Bloat *Bloat `json:"bloat,omitempty"`

	// ASRCopyBytes is the size a 16 kHz mono speech copy would take at the
	// measured duration. It is the honest "what we send to the API" number
	// (case 34), not the source size.
	ASRCopyBytes int64 `json:"asr_copy_bytes,omitempty"`

	Issues []Issue `json:"issues,omitempty"`
}

// Has reports whether an issue code is present.
func (r Report) Has(code string) bool {
	for _, i := range r.Issues {
		if i.Code == code {
			return true
		}
	}
	return false
}

// Issue returns the first issue with a code, if any.
func (r Report) Issue(code string) (Issue, bool) {
	for _, i := range r.Issues {
		if i.Code == code {
			return i, true
		}
	}
	return Issue{}, false
}

// Grid is the sampled-frame layout analysis (cases 37 and 38).
//
// It is intentionally a measurement, not a decision: a static corner region is
// "watermark-like", a busy corner is "face-cam-like". The UI shows the regions
// and leaves crop/blur to the user. Guessing wrong here is cheap; deleting a
// presenter's face because a detector was confident is not.
type Grid struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
	// Motion[i] is the mean absolute frame-to-frame change in cell i, 0..1.
	Motion []float64 `json:"motion"`
	// Detail[i] is the mean spatial standard deviation in cell i, 0..1.
	Detail []float64 `json:"detail"`
	// Samples is how many frames the numbers came from.
	Samples int `json:"samples"`
	// WatermarkRegion is the corner whose pixels barely change ("bottom-left"),
	// empty when no corner qualifies.
	WatermarkRegion string `json:"watermark_region,omitempty"`
	// FaceCamRegion is the corner that is much busier than the frame median,
	// empty when no corner stands out.
	FaceCamRegion string  `json:"facecam_region,omitempty"`
	Confidence    float64 `json:"confidence"`
	Width         int     `json:"width"`
	Height        int     `json:"height"`
}

// --------------------------------------------------------------------- probe

// Probe runs ffprobe once and turns the raw JSON into a Report.
//
// A failed probe is a finding, not a crash: the caller gets a report with a
// probe_failed issue and a nil error only when ffprobe itself could not be
// spawned. A file ffprobe refuses to read still deserves an `action: remux`
// chip rather than a silent import.
func Probe(ctx context.Context, path string) (Report, error) {
	raw, err := runFFprobe(ctx, path)
	if err != nil {
		return Report{
			Path:   path,
			Issues: []Issue{{Code: CodeProbeFailed, Severity: SeverityAction, Title: "Container could not be read", Detail: err.Error(), Fix: "Make a lossless remux copy and import that.", Action: "remux"}},
		}, nil
	}
	rep := AnalyzeJSON(raw)
	rep.Path = path
	return rep, nil
}

// AnalyzeJSON is the pure half of Probe: it takes ffprobe's JSON and produces
// the report, so the whole decision table is testable without a media file.
func AnalyzeJSON(raw []byte) Report {
	var doc probeDoc
	_ = json.Unmarshal(raw, &doc) // a partial document still yields what it has
	return analyze(doc)
}

func analyze(doc probeDoc) Report {
	var rep Report
	rep.Container = doc.Format.FormatName
	rep.DurationSecs = seconds(doc.Format.Duration)
	rep.SizeBytes = int64Of(doc.Format.Size)
	rep.BitRateBps = int64Of(doc.Format.BitRate)
	if rep.DurationSecs <= 0 {
		// Some broken containers only carry the stream duration.
		for _, s := range doc.Streams {
			if d := seconds(s.Duration); d > rep.DurationSecs {
				rep.DurationSecs = d
			}
		}
	}

	var v *probeStream
	var a *probeStream
	for i := range doc.Streams {
		s := &doc.Streams[i]
		switch s.CodecType {
		case "video":
			// Cover art in an MP3 is a video stream with one frame. It must not
			// turn a podcast into a video project.
			if v == nil && !isCoverArt(*s) {
				v = s
			}
		case "audio":
			if a == nil {
				a = s
			}
		}
	}

	if a != nil {
		rep.HasAudio = true
		rep.Audio = &AudioStream{
			Index:        a.Index,
			Codec:        a.CodecName,
			SampleRate:   a.SampleRate,
			Channels:     a.Channels,
			BitRateBps:   int64Of(a.BitRate),
			StartSecs:    seconds(a.StartTime),
			DurationSecs: seconds(a.Duration),
		}
	}
	if v != nil {
		avg, _ := parseRate(v.AvgFrameRate)
		nominal, _ := parseRate(v.RFrameRate)
		fps := avg
		if fps <= 0 {
			fps = nominal
		}
		rep.Video = &VideoStream{
			Index:          v.Index,
			Codec:          v.CodecName,
			Width:          v.Width,
			Height:         v.Height,
			PixelFormat:    v.PixFmt,
			FPS:            round2(fps),
			AvgFrameRate:   v.AvgFrameRate,
			RFrameRate:     v.RFrameRate,
			ColorRange:     v.ColorRange,
			ColorSpace:     v.ColorSpace,
			ColorTransfer:  v.ColorTransfer,
			ColorPrimaries: v.ColorPrimaries,
			StartSecs:      seconds(v.StartTime),
			DurationSecs:   seconds(v.Duration),
			BitRateBps:     int64Of(v.BitRate),
			Frames:         int64Of(v.NbFrames),
		}
		rep.Portrait = v.Height > v.Width && v.Width > 0
		rep.VFR = ratesDiffer(v.AvgFrameRate, v.RFrameRate)
	}

	if v == nil {
		rep.AudioOnly = rep.HasAudio
	}
	if rep.DurationSecs > 0 {
		// 16 kHz mono speech at ~16 kbps: the measured proof in the playbook is
		// 6.0 MB for 50 minutes, which is 16 kbps almost exactly.
		rep.ASRCopyBytes = int64(rep.DurationSecs * 16000 / 8)
	}

	// ---- issues ---------------------------------------------------------
	if v == nil && a == nil {
		rep.Issues = append(rep.Issues, Issue{
			Code: CodeProbeFailed, Severity: SeverityWarn,
			Title:  "No audio or video stream found",
			Detail: "The container opened, but it carries no track the editor can use.",
			Fix:    "Try a lossless remux; if that fails the file is truncated.",
			Action: "remux",
		})
	}
	if v == nil && a != nil {
		rep.Issues = append(rep.Issues, Issue{
			Code: CodeAudioOnly, Severity: SeverityInfo,
			Title:  "Audio project",
			Detail: "There is no picture track. Waveform, transcript and cuts work; the video stage is disabled.",
			Fix:    "Nothing to fix - this is an audio project.",
		})
	}
	if v != nil && a == nil {
		rep.Issues = append(rep.Issues, Issue{
			Code: CodeNoAudio, Severity: SeverityWarn,
			Title:  "No audio track",
			Detail: "There is nothing to transcribe or silence-scan.",
		})
	}

	if v != nil {
		if rep.VFR {
			rep.Issues = append(rep.Issues, Issue{
				Code: CodeVFR, Severity: SeverityInfo,
				Title:  "Variable frame rate",
				Detail: fmt.Sprintf("Nominal %s fps, average %.3f fps. Frame-index maths drifts on this file; timestamps are used instead.", v.RFrameRate, rep.Video.FPS),
				Fix:    "None needed - cuts are time-based, not frame-count-based.",
			})
		}
		if col := colorIssue(*v); col != nil {
			rep.Issues = append(rep.Issues, *col)
		}
		if off := avOffset(*v, a, doc.Format.StartTime); math.Abs(off) >= 0.25 {
			rep.AVOffsetSecs = round3(off)
			dir := "later"
			if off < 0 {
				dir = "earlier"
			}
			rep.Issues = append(rep.Issues, Issue{
				Code: CodeAVOffset, Severity: SeverityWarn,
				Title:  fmt.Sprintf("A/V offset %.2f s", math.Abs(off)),
				Detail: fmt.Sprintf("Audio starts %.2f s %s than the picture. Transcript times and cut points share the audio clock.", math.Abs(off), dir),
				Fix:    "The editor applies this offset when seeking; no re-encode needed.",
			})
		}
		if v.Width > 0 && v.Height > 0 && rep.Video.FPS > 0 {
			if b := bloatFor(*v, rep.Video.FPS, rep.SizeBytes, rep.BitRateBps, rep.DurationSecs, a); b != nil {
				rep.Bloat = b
				rep.Issues = append(rep.Issues, Issue{
					Code: CodeBloat, Severity: SeverityWarn,
					Title:  fmt.Sprintf("%.1f Mbps source - about %.0f%% larger than needed", float64(b.ActualBitrateBps)/1e6, b.SavingsPercent),
					Detail: fmt.Sprintf("%s for %s. The pipeline reads the audio copy (%s), so editing stays fast; the bytes only matter for disk and the final render.", humanBytes(rep.SizeBytes), humanDuration(rep.DurationSecs), humanBytes(rep.ASRCopyBytes)),
					Fix:    "Nothing automatic. An archive copy at the target bitrate is optional and user-triggered.",
				})
			}
		}
		if track, diff := durationSplit(rep.DurationSecs, v, a); diff > 1.5 {
			rep.Issues = append(rep.Issues, Issue{
				Code: CodeDurationSplit, Severity: SeverityAction,
				Title:  "Container duration disagrees with its streams",
				Detail: fmt.Sprintf("Header says %.1f s, the longest track says %.1f s. Seeking near the end can land in the wrong place.", rep.DurationSecs, track),
				Fix:    "Build a lossless remux copy (stream copy, no re-encode) and import that.",
				Action: "remux",
			})
		}
		if rep.Video.FPS > 0 && rep.Video.FPS < 12 {
			rep.Issues = append(rep.Issues, Issue{
				Code: CodeLowFPS, Severity: SeverityInfo,
				Title:  "Low frame rate",
				Detail: fmt.Sprintf("%.1f fps. Preview and filmstrip will look stepped, the cut is unaffected.", rep.Video.FPS),
			})
		}
	}
	if rep.DurationSecs >= 45*60 {
		rep.Issues = append(rep.Issues, Issue{
			Code: CodeLongSource, Severity: SeverityInfo,
			Title:  "Long source",
			Detail: fmt.Sprintf("%s. Transcript and cut map come from the audio copy, so the file length does not become RAM.", humanDuration(rep.DurationSecs)),
		})
	}
	return rep
}

// colorIssue is case 33: SD-era tags on an HD picture.
//
// The pixels are fine; the *labels* are wrong. Players and the preview proxy
// then disagree about whether the values are limited or full range, and a flat
// colour background visibly shifts. Flagging it explains "the app changed my
// colours" before the user says it.
func colorIssue(v probeStream) *Issue {
	if v.Height < 720 {
		return nil
	}
	sdSpace := v.ColorSpace == "smpte170m" || v.ColorSpace == "bt470bg" || v.ColorPrimaries == "smpte170m" || v.ColorPrimaries == "bt470bg"
	fullRange := strings.EqualFold(v.ColorRange, "pc") || strings.EqualFold(v.ColorRange, "jpeg")
	if !sdSpace && !fullRange {
		return nil
	}
	parts := make([]string, 0, 4)
	if v.ColorSpace != "" {
		parts = append(parts, "matrix "+v.ColorSpace)
	}
	if v.ColorPrimaries != "" {
		parts = append(parts, "primaries "+v.ColorPrimaries)
	}
	if v.ColorRange != "" {
		parts = append(parts, "range "+v.ColorRange)
	}
	return &Issue{
		Code: CodeColorMetadata, Severity: SeverityInfo,
		Title:  "Source colour metadata is non-standard for HD",
		Detail: fmt.Sprintf("%s at %dx%d. Some players will show a different gamma/range than others; the source is untouched.", strings.Join(parts, ", "), v.Width, v.Height),
		Fix:    "Preview copies should normalise to bt709 limited range; original bytes stay as they are.",
	}
}

// avOffset measures the picture/audio start difference.
//
// Stream start_time is relative to the container start, so the container's own
// start_time is subtracted. Missing values are treated as zero (the common
// case), which keeps a probe without start_time from inventing an offset.
func avOffset(v probeStream, a *probeStream, formatStart string) float64 {
	if a == nil {
		return 0
	}
	base := seconds(formatStart)
	vs := seconds(v.StartTime)
	var as float64
	if a.StartTime != "" {
		as = seconds(a.StartTime)
	} else {
		as = vs
	}
	return (as - base) - (vs - base)
}

// bloatFor estimates what the file *should* weigh.
//
// 0.07 bits per pixel is a deliberately generous screen-content budget: it
// gives 1080p30 about 4.4 Mbps, well above what a talking-head or screen
// recording needs and below the 14 Mbps re-export in the playbook. A camera
// original at 60 Mbps is not called bloat, because the ratio is measured
// against that budget and 60 Mbps high-motion 4K can genuinely need it.
func bloatFor(v probeStream, fps float64, totalBytes, totalBitrate int64, duration float64, a *probeStream) *Bloat {
	if duration < 90 || v.Width <= 0 || v.Height <= 0 || fps <= 0 {
		return nil
	}
	const bpp = 0.07
	target := int64(float64(v.Width) * float64(v.Height) * fps * bpp)
	if target < 800_000 {
		target = 800_000
	}
	actual := int64Of(v.BitRate)
	if actual <= 0 {
		actual = totalBitrate
		if a != nil && int64Of(a.BitRate) > 0 {
			actual -= int64Of(a.BitRate)
		}
	}
	if actual <= 0 || actual < target*3/2 {
		return nil
	}
	targetBytes := int64(float64(target) / 8 * duration)
	if targetBytes <= 0 || totalBytes <= 0 || targetBytes >= totalBytes*85/100 {
		return nil
	}
	savings := totalBytes - targetBytes
	return &Bloat{
		ActualBitrateBps:  actual,
		TargetBitrateBps:  target,
		TargetBytes:       targetBytes,
		SavingsBytes:      savings,
		SavingsPercent:    round1(float64(savings) / float64(totalBytes) * 100),
		BytesPerMinute:    int64(float64(totalBytes) / (duration / 60)),
		AssumedBitsPerPix: bpp,
	}
}

func durationSplit(total float64, v *probeStream, a *probeStream) (float64, float64) {
	worst, track := 0.0, 0.0
	for _, s := range []*probeStream{v, a} {
		if s == nil {
			continue
		}
		if d := seconds(s.Duration); d > 0 && total > 0 {
			if diff := math.Abs(total - d); diff > worst {
				worst = diff
				track = d
			}
		}
	}
	return track, worst
}

// ------------------------------------------------------------------- ffprobe

type probeDoc struct {
	Format  probeFormat   `json:"format"`
	Streams []probeStream `json:"streams"`
}

type probeFormat struct {
	FormatName string `json:"format_name"`
	Duration   string `json:"duration"`
	Size       string `json:"size"`
	BitRate    string `json:"bit_rate"`
	StartTime  string `json:"start_time"`
}

type probeStream struct {
	Index          int               `json:"index"`
	CodecName      string            `json:"codec_name"`
	CodecType      string            `json:"codec_type"`
	Width          int               `json:"width"`
	Height         int               `json:"height"`
	PixFmt         string            `json:"pix_fmt"`
	AvgFrameRate   string            `json:"avg_frame_rate"`
	RFrameRate     string            `json:"r_frame_rate"`
	ColorRange     string            `json:"color_range"`
	ColorSpace     string            `json:"color_space"`
	ColorTransfer  string            `json:"color_transfer"`
	ColorPrimaries string            `json:"color_primaries"`
	StartTime      string            `json:"start_time"`
	Duration       string            `json:"duration"`
	BitRate        string            `json:"bit_rate"`
	NbFrames       string            `json:"nb_frames"`
	SampleRate     int               `json:"sample_rate"`
	Channels       int               `json:"channels"`
	Disposition    map[string]int    `json:"disposition"`
	Tags           map[string]string `json:"tags"`
}

func isCoverArt(s probeStream) bool {
	// MP3/M4A cover art is an mjpeg/png video stream with a disposition flag.
	if s.Disposition["attached_pic"] == 1 {
		return true
	}
	if s.CodecName == "mjpeg" || s.CodecName == "png" {
		return s.NbFrames == "1" || seconds(s.Duration) <= 0.2
	}
	return false
}

func runFFprobe(ctx context.Context, path string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, ffprobePath(),
		"-v", "error",
		"-print_format", "json",
		"-show_format",
		"-show_streams",
		"--", path,
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("ffprobe timed out after 90s")
	}
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(firstLine(msg))
	}
	return stdout.Bytes(), nil
}

func ffprobePath() string {
	if p := strings.TrimSpace(os.Getenv("T9_FFPROBE")); p != "" {
		return p
	}
	return "ffprobe"
}

func ffmpegPath() string {
	if p := strings.TrimSpace(os.Getenv("T9_FFMPEG")); p != "" {
		return p
	}
	return "ffmpeg"
}

// --------------------------------------------------------------------- remux

// Remux writes a clean container copy without decoding a single frame.
//
// `-map 0` keeps every track (subtitles included), `-c copy` moves the coded
// packets, and `+faststart` moves the index to the front so seeking works
// before the whole file is read. This is case 27's repair: seconds of disk I/O
// instead of minutes of encoding.
func Remux(ctx context.Context, path, outDir string) (string, error) {
	if outDir == "" {
		outDir = DefaultCacheDir()
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", fmt.Errorf("create remux dir: %w", err)
	}
	ext := ".mp4"
	rep, _ := Probe(ctx, path)
	if rep.AudioOnly {
		ext = ".m4a"
	}
	name := fmt.Sprintf("%s-remux-%d%s", sanitizeBase(filepath.Base(path)), time.Now().UnixNano(), ext)
	out := filepath.Join(outDir, name)

	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, ffmpegPath(),
		"-v", "error",
		"-y",
		"-i", path,
		"-map", "0",
		"-c", "copy",
		"-movflags", "+faststart",
		"-ignore_unknown",
		out,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		_ = os.Remove(out)
		if ctx.Err() != nil {
			return "", fmt.Errorf("remux timed out")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(firstLine(msg))
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		_ = os.Remove(out)
		return "", errors.New("remux produced no output")
	}
	return out, nil
}

// DefaultCacheDir is where repair copies live. It is the user cache, never the
// project folder: a repaired copy is disposable and must not appear as a new
// media file the user did not ask for.
func DefaultCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "T9EditorLIT", "remux")
}

// -------------------------------------------------------------------- layout

const (
	gridW = 96
	gridH = 54
)

// SampleGrid reads a bounded number of seeked frames and measures them.
//
// It never asks FFmpeg to decode the whole file: each sample is a fast input
// seek to a keyframe, one frame, scaled to 96x54 greyscale. Twelve samples of
// 5 KB are 60 KB of data and twelve short child processes - not a 5 GB decode.
func SampleGrid(ctx context.Context, path string, duration float64, samples int) (Grid, error) {
	if samples <= 0 {
		samples = 12
	}
	if duration <= 0 {
		return Grid{}, errors.New("unknown duration")
	}
	frames := make([][]byte, 0, samples)
	for i := 0; i < samples; i++ {
		at := duration * float64(i+1) / float64(samples+1)
		frame, err := sampleFrame(ctx, path, at)
		if err != nil {
			continue // one unreadable seek must not lose the other eleven
		}
		frames = append(frames, frame)
	}
	if len(frames) < 3 {
		return Grid{}, fmt.Errorf("only %d of %d samples could be read", len(frames), samples)
	}
	return AnalyzeFrames(frames, gridW, gridH), nil
}

func sampleFrame(ctx context.Context, path string, at float64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	vf := fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=gray", gridW, gridH, gridW, gridH)
	cmd := exec.CommandContext(ctx, ffmpegPath(),
		"-v", "error",
		"-ss", strconv.FormatFloat(at, 'f', 3, 64),
		"-i", path,
		"-frames:v", "1",
		"-vf", vf,
		"-f", "rawvideo",
		"-",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	buf := make([]byte, gridW*gridH)
	_, readErr := io.ReadFull(stdout, buf)
	_ = cmd.Wait()
	if readErr != nil {
		return nil, readErr
	}
	return buf, nil
}

// AnalyzeFrames is the pure layout measurement. Exported so the heuristic can
// be tested with synthetic frames instead of a video fixture.
func AnalyzeFrames(frames [][]byte, w, h int) Grid {
	g := Grid{Cols: 3, Rows: 3, Width: w, Height: h, Samples: len(frames)}
	cells := g.Cols * g.Rows
	if len(frames) == 0 || w <= 0 || h <= 0 {
		return g
	}
	g.Motion = make([]float64, cells)
	g.Detail = make([]float64, cells)

	cellOf := func(x, y int) int {
		cx := x * g.Cols / w
		cy := y * g.Rows / h
		if cx >= g.Cols {
			cx = g.Cols - 1
		}
		if cy >= g.Rows {
			cy = g.Rows - 1
		}
		return cy*g.Cols + cx
	}
	cellSums := make([]float64, cells)
	cellSqs := make([]float64, cells)
	cellCounts := make([]float64, cells)
	for _, f := range frames {
		if len(f) < w*h {
			continue
		}
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				c := cellOf(x, y)
				v := float64(f[y*w+x]) / 255
				cellSums[c] += v
				cellSqs[c] += v * v
				cellCounts[c]++
			}
		}
	}
	for c := 0; c < cells; c++ {
		if cellCounts[c] == 0 {
			continue
		}
		mean := cellSums[c] / cellCounts[c]
		variance := cellSqs[c]/cellCounts[c] - mean*mean
		if variance < 0 {
			variance = 0
		}
		g.Detail[c] = math.Sqrt(variance)
	}

	cellPairCounts := make([]float64, cells)
	for i := 1; i < len(frames); i++ {
		a, b := frames[i-1], frames[i]
		if len(a) < w*h || len(b) < w*h {
			continue
		}
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				c := cellOf(x, y)
				g.Motion[c] += math.Abs(float64(a[y*w+x])-float64(b[y*w+x])) / 255
				cellPairCounts[c]++
			}
		}
	}
	// Motion is a *mean* per cell, so it stays in 0..1 and the frozen-video
	// guard (medianMotion < 0.008) means what it says. Dividing only by the
	// frame-pair count would leave a per-cell sum that grows with cell size:
	// the live file measured 8.7 instead of 0.015, and every threshold in
	// this file would then be comparing numbers with no fixed scale.
	for c := range g.Motion {
		if cellPairCounts[c] > 0 {
			g.Motion[c] /= cellPairCounts[c]
		}
	}

	medianMotion := median(g.Motion)
	medianDetail := median(g.Detail)
	// A frozen video has no static *overlay* to find; everything is static.
	if medianMotion < 0.008 {
		return g
	}

	// Watermark / banner: a corner whose pixels move far less than the picture.
	cornerIdx := map[string]int{
		"top-left": 0, "top-right": g.Cols - 1,
		"bottom-left": (g.Rows - 1) * g.Cols, "bottom-right": cells - 1,
	}
	best := ""
	bestMotion := math.Inf(1)
	for _, name := range []string{"bottom-left", "bottom-right", "top-right", "top-left"} {
		c := cornerIdx[name]
		if g.Detail[c] < 0.015 {
			continue // a flat black corner is not a watermark
		}
		if g.Motion[c] < medianMotion*0.5 && g.Motion[c] < bestMotion {
			bestMotion = g.Motion[c]
			best = name
		}
	}
	g.WatermarkRegion = best
	if best != "" && medianMotion > 0 {
		g.Confidence = clamp01((medianMotion - bestMotion) / medianMotion)
	}

	// Face-cam: a corner much busier than the median, but not the whole frame.
	busy := ""
	busyDetail := 0.0
	for _, name := range []string{"top-right", "top-left", "bottom-right", "bottom-left"} {
		c := cornerIdx[name]
		if g.Detail[c] > medianDetail*1.25 && g.Detail[c] > busyDetail {
			busyDetail = g.Detail[c]
			busy = name
		}
	}
	g.FaceCamRegion = busy
	return g
}

// ------------------------------------------------------------------- helpers

func parseRate(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "0/0" {
		return 0, false
	}
	if i := strings.IndexByte(s, '/'); i > 0 {
		n, err1 := strconv.ParseFloat(s[:i], 64)
		d, err2 := strconv.ParseFloat(s[i+1:], 64)
		if err1 != nil || err2 != nil || d == 0 {
			return 0, false
		}
		return n / d, true
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

func ratesDiffer(avg, nominal string) bool {
	a, oka := parseRate(avg)
	n, okn := parseRate(nominal)
	if !oka || !okn || a <= 0 || n <= 0 {
		return false
	}
	// Compare the rationals exactly rather than with a float epsilon: 29.998
	// versus 30 is a 0.007% difference numerically and a real VFR signal.
	return rational(avg) != rational(nominal)
}

func rational(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '/'); i > 0 {
		n, err1 := strconv.ParseInt(s[:i], 10, 64)
		d, err2 := strconv.ParseInt(s[i+1:], 10, 64)
		if err1 == nil && err2 == nil && d != 0 {
			if g := gcd(abs(n), abs(d)); g > 0 {
				return fmt.Sprintf("%d/%d", n/g, d/g)
			}
		}
	}
	return s
}

func gcd(a, b int64) int64 {
	for b != 0 {
		a, b = b, a%b
	}
	if a < 0 {
		return -a
	}
	return a
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

func seconds(s string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return v
}

func int64Of(s string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		// Some muxers write "N/A" or a float.
		f, ferr := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if ferr != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0
		}
		return int64(f)
	}
	return v
}

func median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	cp := append([]float64(nil), values...)
	sort.Float64s(cp)
	mid := len(cp) / 2
	if len(cp)%2 == 1 {
		return cp[mid]
	}
	return (cp[mid-1] + cp[mid]) / 2
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func sanitizeBase(name string) string {
	name = strings.TrimSuffix(name, filepath.Ext(name))
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		out = "source"
	}
	if len(out) > 40 {
		out = out[:40]
	}
	return out
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}

func humanDuration(secs float64) string {
	total := int(math.Round(secs))
	h, m, s := total/3600, (total%3600)/60, total%60
	if h > 0 {
		return fmt.Sprintf("%dh %02dm", h, m)
	}
	if m > 0 {
		return fmt.Sprintf("%dm %02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}
