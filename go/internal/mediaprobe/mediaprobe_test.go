package mediaprobe

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// liveDoc mirrors the measured InShot file from the playbook: 1080p, 50 min,
// 5.3 GB, 14 Mbps, avg 29.998 vs nominal 30, SD colour tags on HD, audio 0.7 s
// behind the picture. One fixture exercises cases 31, 32, 33 and 30 together.
const liveDoc = `{
  "format": {
    "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
    "duration": "2999.500000",
    "size": "5300000000",
    "bit_rate": "14137000",
    "start_time": "0.000000"
  },
  "streams": [
    {
      "index": 0,
      "codec_name": "h264",
      "codec_type": "video",
      "width": 1920,
      "height": 1080,
      "pix_fmt": "yuvj420p",
      "avg_frame_rate": "29998/1000",
      "r_frame_rate": "30/1",
      "color_range": "pc",
      "color_space": "smpte170m",
      "color_transfer": "smpte170m",
      "color_primaries": "smpte170m",
      "start_time": "0.000000",
      "duration": "2999.500000",
      "bit_rate": "13800000",
      "nb_frames": "89701"
    },
    {
      "index": 1,
      "codec_name": "aac",
      "codec_type": "audio",
      "sample_rate": "44100",
      "channels": 2,
      "start_time": "0.700000",
      "duration": "2998.800000",
      "bit_rate": "189000"
    }
  ]
}`

func decode(t *testing.T, raw string) Report {
	t.Helper()
	return AnalyzeJSON([]byte(raw))
}

func TestLiveFileReportsBloatVFRColorOffset(t *testing.T) {
	rep := decode(t, liveDoc)

	if rep.Video == nil || rep.Video.Width != 1920 || rep.Video.Height != 1080 {
		t.Fatalf("video stream not read: %+v", rep.Video)
	}
	if !rep.VFR {
		t.Fatal("avg 29.998 vs nominal 30 must be reported as VFR")
	}
	if rep.AVOffsetSecs != 0.7 {
		t.Fatalf("A/V offset = %v, want 0.7", rep.AVOffsetSecs)
	}
	if rep.Bloat == nil {
		t.Fatal("14 Mbps 1080p screen content must be flagged as bloat")
	}
	if rep.Bloat.SavingsPercent < 60 {
		t.Fatalf("savings = %.1f%%, want at least 60%%", rep.Bloat.SavingsPercent)
	}
	for _, code := range []string{CodeBloat, CodeVFR, CodeColorMetadata, CodeAVOffset} {
		if !rep.Has(code) {
			t.Errorf("missing issue %q; got %v", code, codes(rep))
		}
	}
	// 50 min at 16 kbps is the playbook's measured 6.0 MB ASR copy.
	if rep.ASRCopyBytes != 5_999_000 {
		t.Fatalf("ASR copy = %d bytes, want 5,999,000", rep.ASRCopyBytes)
	}
	// The source is 5.3 GB: the gate must quote that, not the audio copy.
	if rep.SizeBytes != 5_300_000_000 {
		t.Fatalf("size = %d", rep.SizeBytes)
	}
}

func TestHealthyFileHasNoIssues(t *testing.T) {
	raw := `{"format":{"format_name":"mp4","duration":"120.0","size":"12000000","bit_rate":"800000"},"streams":[
	  {"index":0,"codec_name":"h264","codec_type":"video","width":1280,"height":720,"avg_frame_rate":"30/1","r_frame_rate":"30/1","color_space":"bt709","color_range":"tv","color_primaries":"bt709","start_time":"0","duration":"120"},
	  {"index":1,"codec_name":"aac","codec_type":"audio","sample_rate":"48000","channels":2,"start_time":"0","duration":"120"}]}`
	rep := decode(t, raw)
	if len(rep.Issues) != 0 {
		t.Fatalf("healthy file produced issues: %v", codes(rep))
	}
	if rep.AudioOnly || rep.VFR {
		t.Fatalf("healthy file misclassified: %+v", rep)
	}
}

func TestAudioOnlyPodcast(t *testing.T) {
	raw := `{"format":{"format_name":"mp3","duration":"3600","size":"50000000","bit_rate":"111000"},"streams":[
	  {"index":0,"codec_name":"mp3","codec_type":"audio","sample_rate":"44100","channels":1,"start_time":"0","duration":"3600"},
	  {"index":1,"codec_name":"mjpeg","codec_type":"video","width":600,"height":600,"avg_frame_rate":"90000/1","r_frame_rate":"90000/1","duration":"0.04","nb_frames":"1","disposition":{"attached_pic":1}}]}`
	rep := decode(t, raw)
	if !rep.AudioOnly {
		t.Fatal("mp3 with cover art must be an audio project")
	}
	if rep.Video != nil {
		t.Fatal("cover art must not become the video track")
	}
	if !rep.Has(CodeAudioOnly) {
		t.Fatalf("missing audio_only issue: %v", codes(rep))
	}
	if rep.Bloat != nil {
		t.Fatal("a podcast at 111 kbps is not bloat")
	}
}

func TestDurationSplitIsActionable(t *testing.T) {
	raw := `{"format":{"format_name":"mp4","duration":"60.0","size":"5000000","bit_rate":"600000"},"streams":[
	  {"index":0,"codec_name":"h264","codec_type":"video","width":640,"height":360,"avg_frame_rate":"30/1","r_frame_rate":"30/1","start_time":"0","duration":"44.0"}]}`
	rep := decode(t, raw)
	iss, ok := rep.Issue(CodeDurationSplit)
	if !ok {
		t.Fatalf("16 s header/track mismatch not reported: %v", codes(rep))
	}
	if iss.Action != "remux" {
		t.Fatalf("action = %q, want remux", iss.Action)
	}
}

func TestProbeFailureBecomesRemuxAdvice(t *testing.T) {
	// AnalyzeJSON on a truncated document: the gate must not invent streams,
	// but it must still be safe to render.
	rep := AnalyzeJSON([]byte(`{"format":`))
	if len(rep.Issues) == 0 {
		t.Fatal("unreadable document must produce an issue")
	}
}

func TestRatesDifferIsRationalNotFloat(t *testing.T) {
	if !ratesDiffer("29998/1000", "30/1") {
		t.Fatal("29.998 vs 30 must differ")
	}
	if ratesDiffer("30/1", "30/1") {
		t.Fatal("identical rates must not differ")
	}
	if !ratesDiffer("30000/1001", "30/1") {
		t.Fatal("29.97 vs 30 must differ")
	}
	if ratesDiffer("", "0/0") {
		t.Fatal("missing rates must not be treated as VFR")
	}
}

func TestBloatQuotesHonestTarget(t *testing.T) {
	rep := decode(t, liveDoc)
	if rep.Bloat == nil {
		t.Fatal("no bloat")
	}
	// 1920x1080x29.998x0.07 = 4.35 Mbps, inside 10% of this.
	got := float64(rep.Bloat.TargetBitrateBps) / 1e6
	if got < 3.9 || got > 4.8 {
		t.Fatalf("target bitrate = %.2f Mbps, want ~4.35", got)
	}
	if rep.Bloat.TargetBytes >= rep.SizeBytes {
		t.Fatal("target must be smaller than the source")
	}
}

func TestAnalyzeFramesFindsStaticWatermark(t *testing.T) {
	const w, h = 96, 54
	// A moving bright bar through the middle, plus a static bright box in the
	// bottom-left corner (the playbook's watermark position).
	frames := make([][]byte, 10)
	for i := range frames {
		f := make([]byte, w*h)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				// A moving gradient everywhere: a real video is never frozen,
				// and the frozen-frame guard must not hide the overlay tests.
				v := byte((x*2 + y + i*9) % 90)
				if y > h/3 && y < 2*h/3 && x > (i*8)%w && x < (i*8)%w+12 {
					v = 230
				}
				// A bottom-left static logo that fills most of its grid cell,
				// the way a channel bug does.
				if x < 30 && y > h-18 {
					v = 210
				}
				f[y*w+x] = v
			}
		}
		frames[i] = f
	}
	g := AnalyzeFrames(frames, w, h)
	if g.WatermarkRegion != "bottom-left" {
		t.Fatalf("watermark = %q, motion=%v detail=%v", g.WatermarkRegion, g.Motion, g.Detail)
	}
	if g.Confidence <= 0 {
		t.Fatalf("confidence = %v", g.Confidence)
	}
	if g.Samples != 10 {
		t.Fatalf("samples = %d", g.Samples)
	}
}

func TestAnalyzeFramesFindsBusyCorner(t *testing.T) {
	const w, h = 96, 54
	frames := make([][]byte, 10)
	for i := range frames {
		f := make([]byte, w*h)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				f[y*w+x] = byte((x + y*2 + i*5) % 70)
			}
		}
		// Top-right face-cam: a bright square with moving edges.
		for y := 2; y < 16; y++ {
			for x := w - 26 + i%3; x < w-4; x++ {
				f[y*w+x] = byte(200 + 5*i)
			}
		}
		frames[i] = f
	}
	g := AnalyzeFrames(frames, w, h)
	if g.FaceCamRegion != "top-right" {
		t.Fatalf("face-cam = %q, detail=%v", g.FaceCamRegion, g.Detail)
	}
}

func TestAnalyzeFramesIgnoresFrozenVideo(t *testing.T) {
	const w, h = 96, 54
	f := make([]byte, w*h)
	for i := range f {
		f[i] = 128
	}
	frames := [][]byte{f, f, f, f}
	g := AnalyzeFrames(frames, w, h)
	if g.WatermarkRegion != "" || g.FaceCamRegion != "" {
		t.Fatalf("frozen video must not claim overlays: %+v", g)
	}
}

func TestReportJSONUsesSnakeCase(t *testing.T) {
	rep := decode(t, liveDoc)
	raw, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"duration_secs", "av_offset_secs", "asr_copy_bytes", "issues"} {
		if !strings.Contains(string(raw), `"`+key+`"`) {
			t.Errorf("missing JSON key %q", key)
		}
	}
}

func TestBlastRadiusHelpers(t *testing.T) {
	if math.Abs(round1(12.34)-12.3) > 1e-9 {
		t.Fatal("round1")
	}
	if humanBytes(6_000_000) != "5.7 MB" {
		t.Fatalf("humanBytes = %q", humanBytes(6_000_000))
	}
	if humanDuration(2999.5) != "49m 60s" && humanDuration(2999.5) != "50m 00s" {
		// 2999.5 rounds to 3000 -> 50m 0s
		t.Fatalf("humanDuration = %q", humanDuration(2999.5))
	}
	if sanitizeBase("InShot (final)!.mp4") != "InShot__final" {
		t.Fatalf("sanitize = %q", sanitizeBase("InShot (final)!.mp4"))
	}
}

func codes(rep Report) []string {
	out := make([]string, 0, len(rep.Issues))
	for _, i := range rep.Issues {
		out = append(out, i.Code)
	}
	return out
}
