//! GIF export — the short, looping, picture-only clip.
//!
//! Clipchamp offers GIF next to the video resolutions, with one rule: **GIF
//! is for clips of 15 seconds or less**. This module keeps that rule and
//! renders the kept part of the timeline into one animated GIF.
//!
//! The render is a single FFmpeg child:
//!
//! ```text
//!   trim + setpts  →  concat  →  fps  →  scale  →  split
//!                                                      ├─ palettegen ─┐
//!                                                      └──────────────┴─ paletteuse
//! ```
//!
//! `palettegen` builds one optimal palette for the whole clip and
//! `paletteuse` applies it — that two-pass-over-the-frames dance is what makes
//! a GIF look like a GIF instead of a 256-colour mess.

use crate::export::{parse_progress_line, time_arg, ExportProgress, ExportResult, ProgressLine};
use crate::ffmpeg::run_streaming;
use crate::media::MediaInfo;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// The progress channel — the same one the video export uses.
pub const GIF_EVENT: &str = crate::export::EXPORT_EVENT;

/// The longest clip a GIF export accepts, in seconds. Clipchamp's rule.
pub const GIF_MAX_SECS: f64 = 15.0;

/// Frames per second in the exported GIF.
pub const GIF_FPS: u32 = 10;

/// Width of the exported GIF, in pixels (the height follows the aspect ratio).
pub const GIF_WIDTH: u32 = 480;

/// The filter graph that turns the kept ranges into one animated GIF.
///
/// `trim` + `setpts` per range, joined by `concat`, then sampled at
/// [`GIF_FPS`] and scaled to [`GIF_WIDTH`]. The `split` feeds one branch to
/// `palettegen` and the other to `paletteuse`.
pub fn gif_filter(segments: &[crate::export::Segment]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();
    if segments.len() == 1 {
        let s = &segments[0];
        parts.push(format!(
            "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[vg]",
            time_arg(s.start),
            time_arg(s.end)
        ));
        parts.push("[vg]".to_string());
    } else {
        for (i, s) in segments.iter().enumerate() {
            parts.push(format!(
                "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[v{i}]",
                time_arg(s.start),
                time_arg(s.end)
            ));
        }
        let labels: String = (0..segments.len()).map(|i| format!("[v{i}]")).collect();
        parts.push(format!(
            "{labels}concat=n={}:v=1:a=0[vg]",
            segments.len()
        ));
    }

    parts.push(format!(
        "[vg]fps={GIF_FPS},scale={GIF_WIDTH}:-2:flags=lanczos,split[gs][gp]"
    ));
    parts.push("[gp]palettegen=stats_mode=diff[pal]".to_string());
    parts.push("[gs][pal]paletteuse=dither=bayer:bayer_scale=5[vout]".to_string());
    Some(parts.join(";"))
}

/// The FFmpeg invocation for a GIF export.
fn gif_args(
    source: &Path,
    segments: &[crate::export::Segment],
    output: &Path,
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

    if let Some(filter) = gif_filter(segments) {
        args.push("-filter_complex".into());
        args.push(filter);
        args.push("-map".into());
        args.push("[vout]".into());
    } else {
        args.push("-map".into());
        args.push("0:v:0".into());
    }

    // Loop forever — a GIF that plays once is a bug, not a feature.
    args.push("-loop".into());
    args.push("0".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Export the kept part of the timeline as an animated GIF.
pub fn run_gif_export(
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
    if ext != "gif" {
        return Err("a GIF export needs a .gif output name".to_string());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create output folder {}: {e}", parent.display()))?;
    }

    let info = MediaInfo::probe_any(&source)?;
    let duration = info.duration_secs;

    let segments: Vec<crate::export::Segment> = if req.options.apply_cuts {
        req.segments
            .iter()
            .map(|s| crate::export::Segment {
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
    if total > GIF_MAX_SECS {
        return Err(format!(
            "a GIF is for clips of {GIF_MAX_SECS:.0} seconds or less — this cut is {:.1}s",
            total
        ));
    }

    let mut warnings: Vec<String> = Vec::new();
    if !req.options.apply_cuts {
        warnings
            .push("the timeline's cuts were not applied — the whole recording was exported".into());
    }

    let args = gif_args(&source, &segments, &output);

    let mut last = 0.0f64;
    let out = run_streaming("ffmpeg", &args, Some(Arc::clone(&cancel)), |line| {
        if let Some(ProgressLine::OutTime(t)) = parse_progress_line(line) {
            last = t;
        }
        let percent = ((last / total) * 100.0).clamp(0.0, 100.0);
        let _ = app.emit(
            GIF_EVENT,
            ExportProgress {
                stage: "gif".into(),
                piece_index: 0,
                piece_count: 1,
                percent,
                message: format!(
                    "rendering gif · {}s / {}s",
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
            "gif export failed (exit {}): {}",
            out.status,
            out.stderr_tail.trim()
        ));
    }

    let out_info = MediaInfo::probe_any(&output)
        .map_err(|e| format!("export finished but the output could not be probed: {e}"))?;
    let size_bytes = out_info.size_bytes;

    let _ = app.emit(
        GIF_EVENT,
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
        duration_secs: total,
        size_bytes,
        piece_count: 1,
        encoder: None,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::Segment;

    fn seg(start: f64, end: f64) -> Segment {
        Segment { start, end }
    }

    #[test]
    fn one_range_needs_no_concat() {
        let f = gif_filter(&[seg(0.0, 5.0)]).expect("a filter");
        assert!(f.contains("trim=start=0.000000:end=5.000000"), "got {f}");
        assert!(!f.contains("concat"), "one range needs no concat: {f}");
        assert!(f.contains("palettegen"), "got {f}");
        assert!(f.contains("paletteuse"), "got {f}");
    }

    #[test]
    fn many_ranges_are_joined() {
        let f = gif_filter(&[seg(0.0, 2.0), seg(4.0, 6.0)]).expect("a filter");
        assert!(f.contains("concat=n=2:v=1:a=0"), "got {f}");
    }

    #[test]
    fn the_graph_samples_and_scales() {
        let f = gif_filter(&[seg(0.0, 2.0)]).expect("a filter");
        assert!(f.contains(&format!("fps={GIF_FPS}")), "got {f}");
        assert!(f.contains(&format!("scale={GIF_WIDTH}:-2")), "got {f}");
    }

    #[test]
    fn no_ranges_means_no_filter() {
        assert!(gif_filter(&[]).is_none());
    }
}
