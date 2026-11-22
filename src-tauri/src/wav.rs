//! WAV audio-only export (lossless PCM).
//!
//! The sibling of `mp3.rs`: the kept ranges are trimmed and joined in one
//! FFmpeg child process and written as 16-bit PCM. No intermediate files, no
//! heap buffering — a five-hour source costs the same RAM as a five-second one.

use crate::export::{
    ExportProgress, ExportResult, ProgressLine, Segment, parse_progress_line,
};
use crate::ffmpeg::run_streaming;
use crate::media::MediaInfo;
use crate::mp3::audio_filter;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

pub const WAV_EVENT: &str = crate::export::EXPORT_EVENT;

fn wav_args(
    source: &PathBuf,
    segments: &[Segment],
    output: &PathBuf,
    options: &crate::export::ExportOptions,
) -> Vec<String> {
    let mut args = vec![
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
            args.push("-map".into());
            args.push("0:a:0".into());
        }
    }
    args.push("-vn".into());
    args.push("-c:a".into());
    args.push("pcm_s16le".into());
    args.push("-ar".into());
    args.push(options.sample_rate.clamp(8000, 192000).to_string());
    args.push("-ac".into());
    args.push(options.channels.clamp(1, 2).to_string());
    args.push("-f".into());
    args.push("wav".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Export the kept part of the timeline as one lossless WAV file.
pub fn run_wav_export(
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
    if ext != "wav" {
        return Err("a WAV export needs a .wav output name".to_string());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create output folder {}: {e}", parent.display()))?;
    }

    let info = MediaInfo::probe_any(&source)?;
    if !info.has_audio {
        return Err("this file has no audio track".to_string());
    }

    let duration = info.duration_secs;
    let segments: Vec<Segment> = if req.options.apply_cuts {
        req.segments
            .iter()
            .map(|s| Segment {
                start: s.start.clamp(0.0, duration),
                end: s.end.clamp(0.0, duration),
                gain: crate::export::segment_gain(s.gain),
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
    if req.options.normalize {
        warnings.push("loudness normalization is not applied to lossless PCM — use MP3 for that".into());
    }

    let args = wav_args(&source, &segments, &output, &req.options);
    let mut last = 0.0f64;
    let out = run_streaming("ffmpeg", &args, Some(Arc::clone(&cancel)), |line| {
        if let Some(ProgressLine::OutTime(t)) = parse_progress_line(line) {
            last = t;
        }
        let percent = ((last / total) * 100.0).clamp(0.0, 100.0);
        let _ = app.emit(
            WAV_EVENT,
            ExportProgress {
                stage: "audio".into(),
                piece_index: 0,
                piece_count: 1,
                percent,
                message: format!(
                    "encoding wav · {}s / {}s",
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
            "wav export failed (exit {}): {}",
            out.status,
            out.stderr_tail.trim()
        ));
    }

    let out_info = MediaInfo::probe_any(&output)
        .map_err(|e| format!("export finished but the output could not be probed: {e}"))?;
    if (out_info.duration_secs - total).abs() > total.max(1.0) * 0.05 + 1.0 {
        warnings.push(format!(
            "output duration {:.2}s differs from the expected {:.2}s — check the cut points",
            out_info.duration_secs, total
        ));
    }

    let _ = app.emit(
        WAV_EVENT,
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
        encoder: Some("pcm_s16le".to_string()),
        warnings,
    })
}
