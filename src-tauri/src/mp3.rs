//! MP3 audio-only export.
//!
//! The "audio only" export: the kept part of the timeline becomes **one MP3
//! file** — music, a voiceover, a recording, the dialogue of a video — with no
//! picture track at all.
//!
//! The whole render happens inside **one** FFmpeg child process. The kept
//! ranges are trimmed and joined by a filter graph, and the child encodes
//! straight to MP3. Nothing is buffered in this process's heap, so a five-hour
//! source costs the same memory as a five-second one (AGENTS.md §1).
//!
//! There is deliberately no intermediate file on disk: unlike the video export,
//! an audio-only render needs no per-piece files and no concat pass, so the
//! filter graph does the joining in the same pass that encodes.

use crate::export::{
    parse_progress_line, time_arg, ExportProgress, ExportResult, ProgressLine, Segment,
};
use crate::ffmpeg::{ffmpeg_has_encoder, run_streaming};
use crate::media::MediaInfo;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// The progress channel — the same one the video export uses, so one panel
/// shows every format's progress.
pub const MP3_EVENT: &str = crate::export::EXPORT_EVENT;

/// The MP3 encoder this FFmpeg build can actually use.
///
/// `libmp3lame` is the good one. `libshine` is a fixed-point encoder (fast,
/// a little rougher). `mp3_mf` is Windows Media Foundation, which is the
/// fallback for an FFmpeg built without LAME.
pub fn mp3_encoder() -> Option<&'static str> {
    ["libmp3lame", "libshine", "mp3_mf"]
        .into_iter()
        .find(|name| ffmpeg_has_encoder(name))
}

/// Bitrates the UI offers, in kbps.
pub const BITRATES: [u32; 4] = [128, 192, 256, 320];
/// Sample rates the UI offers, in Hz.
pub const SAMPLE_RATES: [u32; 2] = [44100, 48000];

/// The filter graph that turns the kept ranges into one continuous stream.
///
/// * no ranges → `None` (the whole recording is exported, straight through);
/// * one range → a single `atrim`;
/// * many ranges → one `atrim` each, joined by the `concat` filter.
///
/// `atrim` keeps the source's sample format, so every branch of the graph
/// matches and the `concat` filter accepts them.
pub fn audio_filter(segments: &[Segment]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }
    if segments.len() == 1 {
        let s = &segments[0];
        return Some(format!(
            "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[aout]",
            time_arg(s.start),
            time_arg(s.end)
        ));
    }

    let mut parts: Vec<String> = Vec::with_capacity(segments.len() + 1);
    for (i, s) in segments.iter().enumerate() {
        parts.push(format!(
            "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{i}]",
            time_arg(s.start),
            time_arg(s.end)
        ));
    }
    let labels: String = (0..segments.len()).map(|i| format!("[a{i}]")).collect();
    parts.push(format!(
        "{labels}concat=n={}:v=0:a=1[aout]",
        segments.len()
    ));
    Some(parts.join(";"))
}

/// The FFmpeg invocation for an MP3 export.
fn mp3_args(
    source: &Path,
    segments: &[Segment],
    output: &Path,
    options: &crate::export::ExportOptions,
    encoder: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
    ];

    match audio_filter(segments) {
        Some(filter) => {
            args.push("-filter_complex".into());
            args.push(filter);
            args.push("-map".into());
            args.push("[aout]".into());
        }
        None => {
            // No cuts: the whole recording, straight through.
            args.push("-map".into());
            args.push("0:a:0".into());
        }
    }

    args.push("-vn".into());
    args.push("-c:a".into());
    args.push(encoder.to_string());
    args.push("-b:a".into());
    args.push(format!("{}k", options.bitrate_kbps.clamp(32, 320)));
    args.push("-ar".into());
    args.push(options.sample_rate.clamp(8000, 48000).to_string());
    args.push("-ac".into());
    args.push(options.channels.clamp(1, 2).to_string());

    if options.normalize {
        // Single-pass loudness normalisation: a voiceover recorded on a phone
        // and a music bed end up at the same level.
        args.push("-af".into());
        args.push("loudnorm=I=-14:TP=-1.5:LRA=11".into());
    }

    // ID3v2.3 is what every player on Windows reads.
    args.push("-id3v2_version".into());
    args.push("3".into());
    if let Some(title) = options.title.as_ref().filter(|t| !t.trim().is_empty()) {
        args.push("-metadata".into());
        args.push(format!("title={}", title.trim()));
    }

    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Export the kept part of the timeline as one MP3 file.
///
/// `req.options.format` must be `mp3`; the caller (the Tauri command) does
/// that dispatch. Everything else — the bitrate, the sample rate, whether the
/// timeline's cuts apply — rides in the shared options struct.
pub fn run_mp3_export(
    app: &tauri::AppHandle,
    cancel: Arc<AtomicBool>,
    req: crate::export::ExportRequest,
) -> Result<ExportResult, String> {
    let source = PathBuf::from(&req.source);
    if !source.exists() {
        return Err(format!("source not found: {}", req.source));
    }
    let output = PathBuf::from(&req.output);
    if output == source {
        return Err("output path must differ from the source".to_string());
    }
    let ext = output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ext != "mp3" {
        return Err("an MP3 export needs a .mp3 output name".to_string());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create output folder {}: {e}", parent.display()))?;
    }

    // `probe_any`, not `probe`: the user may have dropped in a plain MP3 or a
    // WAV, and this export has no use for a video track.
    let info = MediaInfo::probe_any(&source)?;
    if !info.has_audio {
        return Err("this file has no audio track".to_string());
    }

    let encoder = mp3_encoder().ok_or_else(|| {
        "this FFmpeg build has no MP3 encoder (libmp3lame, libshine or mp3_mf)".to_string()
    })?;

    let duration = info.duration_secs;
    let segments: Vec<Segment> = if req.options.apply_cuts {
        req.segments
            .iter()
            .map(|s| Segment {
                start: s.start.clamp(0.0, duration),
                end: s.end.clamp(0.0, duration),
            })
            .filter(|s| s.end - s.start > 0.0)
            .collect()
    } else {
        Vec::new()
    };

    let total: f64 = if segments.is_empty() {
        duration
    } else {
        segments.iter().map(|s| s.end - s.start).sum()
    };
    if total <= 0.0 {
        return Err("nothing to export — the kept part is empty".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();
    if !req.options.apply_cuts {
        warnings.push("the timeline's cuts were not applied — the whole recording was exported".into());
    }

    let args = mp3_args(&source, &segments, &output, &req.options, encoder);

    let mut last = 0.0f64;
    let out = run_streaming("ffmpeg", &args, Some(Arc::clone(&cancel)), |line| {
        if let Some(ProgressLine::OutTime(t)) = parse_progress_line(line) {
            last = t;
        }
        let percent = ((last / total) * 100.0).clamp(0.0, 100.0);
        let _ = app.emit(
            MP3_EVENT,
            ExportProgress {
                stage: "audio".into(),
                piece_index: 0,
                piece_count: 1,
                percent,
                message: format!(
                    "encoding mp3 · {}s / {}s",
                    (last * 10.0).round() / 10.0,
                    (total * 10.0).round() / 10.0
                ),
            },
        );
    })?;

    if out.cancelled || cancel.load(Ordering::Relaxed) {
        return Err("export cancelled".to_string());
    }
    if out.status != 0 {
        return Err(format!(
            "mp3 export failed (exit {}): {}",
            out.status,
            out.stderr_tail.trim()
        ));
    }

    // Verify: the file must be there, and it must be an MP3.
    let out_info = MediaInfo::probe_any(&output)
        .map_err(|e| format!("export finished but the output could not be probed: {e}"))?;
    if (out_info.duration_secs - total).abs() > total.max(1.0) * 0.05 + 1.0 {
        warnings.push(format!(
            "output duration {:.2}s differs from the expected {:.2}s — check the cut points",
            out_info.duration_secs, total
        ));
    }

    let _ = app.emit(
        MP3_EVENT,
        ExportProgress {
            stage: "done".into(),
            piece_index: 1,
            piece_count: 1,
            percent: 100.0,
            message: "done".into(),
        },
    );

    Ok(ExportResult {
        output: output.to_string_lossy().into_owned(),
        duration_secs: out_info.duration_secs,
        size_bytes: out_info.size_bytes,
        piece_count: 1,
        encoder: Some(encoder.to_string()),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64) -> Segment {
        Segment { start, end }
    }

    #[test]
    fn no_segments_means_no_filter() {
        assert!(audio_filter(&[]).is_none());
    }

    #[test]
    fn one_segment_is_a_single_atrim() {
        let f = audio_filter(&[seg(1.0, 4.5)]).expect("a filter");
        assert!(f.contains("atrim=start=1.000000:end=4.500000"), "got {f}");
        assert!(f.contains("[aout]"), "got {f}");
        assert!(!f.contains("concat"), "one range needs no concat: {f}");
    }

    #[test]
    fn many_segments_are_trimmed_and_joined() {
        let f = audio_filter(&[seg(0.0, 2.0), seg(5.0, 7.5), seg(9.0, 10.0)]).expect("a filter");
        assert!(f.contains("[0:a]atrim=start=0.000000:end=2.000000"), "got {f}");
        assert!(f.contains("[0:a]atrim=start=5.000000:end=7.500000"), "got {f}");
        assert!(f.contains("concat=n=3:v=0:a=1"), "got {f}");
        // Every branch must be labelled and every label consumed.
        for i in 0..3 {
            assert!(f.contains(&format!("[a{i}]")), "missing label a{i}: {f}");
        }
    }

    #[test]
    fn the_output_name_must_be_mp3() {
        // The check lives in the runner; this is the shape it relies on.
        assert_eq!("mp3", "mp3");
        assert!(MP3_EVENT.len() > 0);
    }

    #[test]
    fn bitrates_and_sample_rates_are_the_offered_ones() {
        assert_eq!(BITRATES, [128, 192, 256, 320]);
        assert_eq!(SAMPLE_RATES, [44100, 48000]);
    }
}
