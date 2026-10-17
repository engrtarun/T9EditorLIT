//! Smart hybrid export engine (Chunk 4).
//!
//! The Cut panel only records *decisions* — nothing has touched the 5 GB file
//! yet. This module turns those decisions into a rendered file, in three steps
//! that each respect the zero-RAM rule (AGENTS.md §1):
//!
//! 1. **Plan** — map every cut point onto the source's I-frame grid (from
//!    [`crate::keyframes`]) and split the kept timeline into pieces.
//!    * piece **starts** on a keyframe → `-c copy`, instant and lossless;
//!    * piece **starts mid-GOP** → only that partial GOP (typically 1–2 s) is
//!      re-encoded on QuickSync/NVENC/AMF, the rest of the segment is copied.
//! 2. **Cut** — one short-lived `ffmpeg` child per piece, writing into a
//!    work folder beside the destination. Children are hard-killed on Cancel.
//! 3. **Concat** — the FFmpeg concat demuxer stitches the pieces with another
//!    stream copy. Progress from both phases rides `-progress pipe:1` out to
//!    the UI as `export-progress` events.
//!
//! Every FFmpeg invocation is a child process; this module never holds media
//! in memory — only a few thousand keyframe timestamps and a progress line.

use crate::ffmpeg::{ffmpeg_encoder_usable, ffmpeg_has_encoder, run_streaming};
use crate::keyframes;
use crate::media::MediaInfo;
use crate::transcript;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Emitter;

/// Tauri event name the UI listens on for live render progress.
pub const EXPORT_EVENT: &str = "export-progress";

/// Cut points in seconds. What the transcript's ✓/✕ decisions become once the
/// gaps between kept lines are closed up.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
}

/// Why a piece exists: a straight bitstream copy, or a short re-encode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PieceKind {
    Copy,
    Encode,
}

/// One unit of work: a contiguous slice of the source plus how to cut it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Piece {
    pub index: usize,
    pub segment_index: usize,
    pub start: f64,
    pub end: f64,
    pub kind: PieceKind,
    pub duration_secs: f64,
}

/// What the user asked the engine to do.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    /// `hybrid` (default) · `copy` (snap to keyframes, never encode) ·
    /// `encode` (exact cuts, everything re-encoded).
    pub mode: String,
    /// How close a cut point may sit to a keyframe and still count as aligned.
    pub align_tolerance_ms: f64,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            mode: "hybrid".to_string(),
            align_tolerance_ms: 40.0,
        }
    }
}

/// Everything both `plan_export` and `start_export` need.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportRequest {
    pub source: String,
    pub segments: Vec<Segment>,
    pub output: String,
    pub options: ExportOptions,
    /// SQLite path for the keyframe cache — optional, but without it every
    /// export re-reads the whole source to find its I-frames.
    pub db_path: Option<String>,
}

impl Default for ExportRequest {
    fn default() -> Self {
        Self {
            source: String::new(),
            segments: Vec::new(),
            output: String::new(),
            options: ExportOptions::default(),
            db_path: None,
        }
    }
}

/// The full render recipe — also what the panel shows before anything runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub source: String,
    pub output: String,
    /// Mode actually used — `hybrid` downgrades to `encode` when the source
    /// codec cannot be mixed with re-encoded pieces.
    pub mode: String,
    pub duration_secs: f64,
    pub output_duration_secs: f64,
    pub segments: Vec<Segment>,
    pub pieces: Vec<Piece>,
    pub copy_pieces: usize,
    pub encode_pieces: usize,
    /// Encoder used for micro-encodes, e.g. `h264_qsv`.
    pub encoder: Option<String>,
    /// Keyframes known in the source — the size of the grid cuts snap to.
    pub keyframe_count: usize,
    /// Audio is copied when the container accepts it, else encoded to AAC
    /// identically in every piece (a concat must not change codec midway).
    pub audio_copied: bool,
    pub estimated_size_bytes: u64,
    pub warnings: Vec<String>,
}

/// What a finished export left on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output: String,
    pub duration_secs: f64,
    pub size_bytes: u64,
    pub piece_count: usize,
    pub encoder: Option<String>,
    pub warnings: Vec<String>,
}

/// Payload of the `export-progress` event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    /// `scan` · `cut` · `concat` · `done`.
    pub stage: String,
    /// 1-based piece being cut, 0 outside the cutting phase.
    pub piece_index: usize,
    pub piece_count: usize,
    /// 0–100 across the whole job.
    pub percent: f64,
    pub message: String,
}

/// Cutting is 85 % of the bar, concat the remaining 15 %: pieces are where the
/// encode time goes, the concat is a disk-bound remux.
const WEIGHT_CUT: f64 = 85.0;
const WEIGHT_CONCAT: f64 = 15.0;

/// A piece shorter than this is a sliver, not a piece of work.
const MIN_PIECE: f64 = 0.05;
/// Two doubles from the same keyframe list must not differ by rounding noise.
const SNAP_EPS: f64 = 1e-6;
/// Seek a copy piece this far past its keyframe so a timestamp rounded down by
/// ffprobe's output precision can never pull the cut back a whole GOP.
const COPY_SEEK_EPS: f64 = 1e-6;

// ───────────────────────────── pure planning ─────────────────────────────

/// Sort, de-noise and complete an I-frame list: the start of the file and the
/// end of the file are legal copy boundaries whether or not ffprobe printed
/// them.
pub fn normalise_keyframes(mut times: Vec<f64>, duration: f64) -> Vec<f64> {
    times.retain(|t| t.is_finite() && *t >= 0.0);
    times.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    times.dedup_by(|a, b| (*a - *b).abs() < SNAP_EPS);

    if times.first().is_none_or(|t| *t > 0.0) {
        times.insert(0, 0.0);
    }
    if duration > 0.0 && times.last().is_some_and(|t| duration - *t > SNAP_EPS) {
        times.push(duration);
    }
    times
}

/// The keyframe nearest to `t`, or `None` on an empty grid.
fn nearest_keyframe(t: f64, kfs: &[f64]) -> Option<f64> {
    if kfs.is_empty() {
        return None;
    }
    let idx = kfs.partition_point(|k| *k < t);
    let after = (idx < kfs.len()).then_some(kfs[idx]);
    let before = idx.checked_sub(1).map(|i| kfs[i]);
    [before, after]
        .into_iter()
        .flatten()
        .min_by(|a, b| (a - t).abs().partial_cmp(&(b - t).abs()).unwrap_or(std::cmp::Ordering::Equal))
}

/// `Some(keyframe)` when `t` sits within `tol` of a keyframe — the cut can be
/// stream-copied after a nudge no larger than the tolerance.
fn aligned(t: f64, kfs: &[f64], tol: f64) -> Option<f64> {
    nearest_keyframe(t, kfs).filter(|k| (k - t).abs() <= tol)
}

/// First keyframe strictly after `t` — where a mid-GOP start can hand over to a
/// stream copy.
fn next_keyframe_after(t: f64, kfs: &[f64]) -> Option<f64> {
    kfs.iter().copied().find(|k| *k > t + SNAP_EPS)
}

/// Result of planning: pieces plus the diagnostics the panel can surface.
#[derive(Debug, Default, PartialEq)]
pub struct PlanOutcome {
    pub pieces: Vec<Piece>,
    /// Segments copy mode could not represent at all (shorter than a GOP).
    pub dropped_segments: usize,
    /// Largest distance a cut point was moved to reach a keyframe.
    pub max_snap_secs: f64,
}

/// Turn kept ranges into an ordered piece list for one mode.
///
/// Hybrid — the interesting one — needs at most two pieces per segment:
///
/// ```text
///   source:  ────[I]═══════[I]═══════[I]═══════[I]═══════
///   segment:          └───────────────┘
///   cut at s (mid-GOP):  ▲ encode ▲├──── copy ────┤
/// ```
///
/// The segment's head is the partial GOP that starts mid-GOP — re-encoded so
/// the first frame really is `s` — and everything from the next I-frame to the
/// segment end is a plain stream copy that ends wherever it ends: only a
/// piece's *start* has to be a keyframe.
pub fn plan_pieces(segments: &[Segment], kfs: &[f64], opts: &ExportOptions) -> PlanOutcome {
    let tol = (opts.align_tolerance_ms / 1000.0).max(0.0);
    let mut outcome = PlanOutcome::default();

    for (segment_index, seg) in segments.iter().enumerate() {
        let raw: Vec<(f64, f64, PieceKind)> = match opts.mode.as_str() {
            "encode" => vec![(seg.start, seg.end, PieceKind::Encode)],
            "copy" => {
                // Snap inward-when-far: never pull cut content back in, and
                // never let a keyframe-shifted start leak past `s`.
                let start = aligned(seg.start, kfs, tol)
                    .or_else(|| next_keyframe_after(seg.start, kfs))
                    .unwrap_or(seg.start);
                let end = aligned(seg.end, kfs, tol)
                    .or_else(|| prev_keyframe_before(seg.end, kfs))
                    .unwrap_or(seg.end);
                outcome.max_snap_secs = outcome
                    .max_snap_secs
                    .max((start - seg.start).abs())
                    .max((end - seg.end).abs());
                if end - start <= MIN_PIECE {
                    outcome.dropped_segments += 1;
                    Vec::new()
                } else {
                    vec![(start, end, PieceKind::Copy)]
                }
            }
            _ => {
                if let Some(start) = aligned(seg.start, kfs, tol) {
                    // Aligned start → try to snap the end too for a clean copy piece.
                    let end = aligned(seg.end, kfs, tol).unwrap_or(seg.end);
                    let start = start.min(end);
                    outcome.max_snap_secs = outcome
                        .max_snap_secs
                        .max((start - seg.start).abs())
                        .max((end - seg.end).abs());
                    if end - start > MIN_PIECE {
                        vec![(start, end, PieceKind::Copy)]
                    } else {
                        vec![]
                    }
                } else {
                    match next_keyframe_after(seg.start, kfs) {
                        // Mid-GOP start: micro-encode the partial GOP only.
                        Some(k) if k + MIN_PIECE < seg.end => vec![
                            (seg.start, k, PieceKind::Encode),
                            (k, seg.end, PieceKind::Copy),
                        ],
                        // The segment dies inside one GOP (or ends before the
                        // next I-frame): there is no boundary to hand over at.
                        _ => vec![(seg.start, seg.end, PieceKind::Encode)],
                    }
                }
            }
        };

        for (start, end, kind) in raw {
            if end - start <= SNAP_EPS {
                continue;
            }
            outcome.pieces.push(Piece {
                index: outcome.pieces.len(),
                segment_index,
                start,
                end,
                kind,
                duration_secs: end - start,
            });
        }
    }
    outcome
}

/// Last keyframe at or before `t`.
fn prev_keyframe_before(t: f64, kfs: &[f64]) -> Option<f64> {
    let idx = kfs.partition_point(|k| *k < t);
    match idx {
        0 => None,
        i => Some(kfs[i - 1]),
    }
}

/// The concat demuxer's own list syntax, with Windows paths flattened to
/// forward slashes — backslashes are escape characters inside `ffconcat`
/// quotes, so `C:\Users` would otherwise parse as `C:Users`.
pub fn concat_list_text(paths: &[PathBuf]) -> String {
    let mut out = String::from("ffconcat version 1.0\n");
    for p in paths {
        let flat = p.to_string_lossy().replace('\\', "/");
        out.push_str("file '");
        out.push_str(&flat.replace('\'', "'\\''"));
        out.push_str("'\n");
    }
    out
}

/// Rough output size: copied duration costs its share of the source, encoded
/// duration a little less because re-encoding compresses.
fn estimate_size(info: &MediaInfo, pieces: &[Piece]) -> u64 {
    if info.duration_secs <= 0.0 || info.size_bytes == 0 {
        return 0;
    }
    let per_second = info.size_bytes as f64 / info.duration_secs;
    let bytes: f64 = pieces
        .iter()
        .map(|p| {
            let share = per_second * p.duration_secs;
            match p.kind {
                PieceKind::Copy => share,
                PieceKind::Encode => share * 0.7,
            }
        })
        .sum();
    bytes.round() as u64
}

/// One line of `ffmpeg -progress pipe:1`.
#[derive(Debug, PartialEq)]
pub enum ProgressLine {
    /// Seconds encoded so far.
    OutTime(f64),
    /// e.g. `2.5x`.
    Speed(f64),
    /// `continue` or `end`.
    Status(String),
}

/// Parse the `-progress` stream. `out_time` (a `HH:MM:SS.ffffff` string) is
/// preferred over `out_time_ms`, which FFmpeg reports in *microseconds* — a
/// long-standing quirk that would put a progress bar 1000× ahead of reality.
pub fn parse_progress_line(line: &str) -> Option<ProgressLine> {
    let (key, value) = line.trim().split_once('=')?;
    let value = value.trim();
    match key {
        "out_time" => parse_hhmmss(value).map(ProgressLine::OutTime),
        "speed" => value.trim_end_matches('x').parse::<f64>().ok().map(ProgressLine::Speed),
        "progress" => Some(ProgressLine::Status(value.to_string())),
        _ => None,
    }
}

/// `01:02:03.500000` → seconds. `N/A` and friends return `None`.
fn parse_hhmmss(value: &str) -> Option<f64> {
    if value.eq_ignore_ascii_case("n/a") {
        return None;
    }
    let (time, frac) = value.split_once('.')?;
    let mut parts = time.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    // "500000" means 0.500000 s — scale by the digit count, not by guessing.
    let frac = if frac.is_empty() || !frac.chars().all(|c| c.is_ascii_digit()) {
        0.0
    } else {
        let digits: f64 = frac.parse().ok()?;
        digits / 10f64.powi(frac.len() as i32)
    };
    Some(h * 3600.0 + m * 60.0 + s + frac)
}

/// Which encoder family a source belongs to — pieces must stay in-family or
/// the concat demuxer cannot stitch them.
fn family_of(video_codec: &str) -> Option<&'static str> {
    match video_codec {
        "h264" => Some("h264"),
        "hevc" => Some("hevc"),
        _ => None,
    }
}

/// Pick a working encoder for a family: hardware first (QuickSync on the
/// target i3), CPU as the fallback for a piece the hardware rejects.
///
/// `-encoders` alone only lists what the *build* knows, so each candidate is
/// also asked to encode five synthetic frames — a build with h264_qsv on a box
/// with no iGPU must not be allowed to fail ten minutes into a render.
fn pick_encoder(family: &str) -> Result<(Option<String>, Option<String>), String> {
    let (hw, cpu) = match family {
        "hevc" => (
            vec!["hevc_qsv", "hevc_nvenc", "hevc_amf"],
            Some("libx265"),
        ),
        _ => (
            vec!["h264_qsv", "h264_nvenc", "h264_amf"],
            Some("libx264"),
        ),
    };

    let cpu_ok = cpu.filter(|c| ffmpeg_has_encoder(c) && ffmpeg_encoder_usable(c));
    let hw_ok = hw
        .into_iter()
        .find(|e| ffmpeg_has_encoder(e) && ffmpeg_encoder_usable(e));

    match (hw_ok, cpu_ok) {
        (Some(hw), cpu) => Ok((Some(hw.to_string()), cpu.map(str::to_string))),
        (None, Some(cpu)) => Ok((Some(cpu.to_string()), None)),
        (None, None) => Err(format!(
            "no usable {family} encoder — FFmpeg reports none of {} working",
            if family == "hevc" { "hevc_qsv/hevc_nvenc/hevc_amf/libx265" } else { "h264_qsv/h264_nvenc/h264_amf/libx264" }
        )),
    }
}

/// Audio handling, decided once for the whole export: a concat must not change
/// codec midway, and MP4 refuses some source audio codecs outright.
fn audio_copied(info: &MediaInfo, output: &Path) -> (bool, Vec<String>) {
    if !info.has_audio {
        return (false, Vec::new());
    }
    let codec = info.audio_codec.as_deref().unwrap_or("");
    let wants_mp4 = output
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp4"));
    // What MP4 can hold natively; anything else (PCM, TrueHD, …) goes to AAC
    // in every piece so the stream stays one codec end to end.
    let mp4_native = ["aac", "mp3", "opus", "ac3", "eac3", "alac"];
    if wants_mp4 && !mp4_native.contains(&codec) {
        (
            false,
            vec![format!(
                "source audio ({codec}) is not MP4-native — audio is encoded to AAC in every piece"
            )],
        )
    } else {
        (true, Vec::new())
    }
}

/// Build the full recipe. Pure with respect to the filesystem apart from the
/// encoder probes, which each run at most once per process.
pub fn build_plan(req: &ExportRequest, info: &MediaInfo, kfs: &[f64]) -> Result<ExportPlan, String> {
    let mode = req.options.mode.as_str();
    if !matches!(mode, "hybrid" | "copy" | "encode") {
        return Err(format!("unknown export mode: {mode}"));
    }
    if req.output.trim().is_empty() {
        return Err("no output path chosen".to_string());
    }

    let duration = info.duration_secs;
    let segments: Vec<Segment> = req
        .segments
        .iter()
        .filter_map(|s| {
            let start = s.start.clamp(0.0, duration);
            let end = s.end.clamp(0.0, duration);
            (end - start > SNAP_EPS).then_some(Segment { start, end })
        })
        .collect();
    if segments.is_empty() {
        return Err("nothing to export — no kept segments".to_string());
    }

    let mut warnings = Vec::new();
    let mut effective_mode = mode.to_string();

    // Re-encoded pieces must share the source's codec family, or the concat
    // would have to stitch H.264 into VP9. Sources we cannot stay in-family
    // with are exported in full instead of silently mixing streams.
    if effective_mode == "hybrid" {
        let video = info.video_codec.as_deref().unwrap_or("");
        if family_of(video).is_none() {
            effective_mode = "encode".to_string();
            warnings.push(format!(
                "source codec {video} cannot be mixed with re-encoded pieces — exporting the full timeline in one family"
            ));
        }
    }

    let keyframes = normalise_keyframes(kfs.to_vec(), duration);
    let outcome = plan_pieces(&segments, &keyframes, &req.options.options_copy(&effective_mode));

    if outcome.pieces.is_empty() {
        return Err("nothing to export — every segment is shorter than one GOP in copy mode"
            .to_string());
    }

    let needs_encode = outcome.pieces.iter().any(|p| p.kind == PieceKind::Encode);
    let mut encoder = None;
    if needs_encode {
        // Stay in the source's codec family when it has one; otherwise the
        // whole timeline is rendered as h264 for compatibility.
        let family = family_of(info.video_codec.as_deref().unwrap_or("")).unwrap_or("h264");
        let (primary, fallback) = pick_encoder(family)?;
        let primary_is_hardware = primary.as_deref().is_some_and(|e| {
            ["qsv", "nvenc", "amf"].iter().any(|tag| e.contains(tag))
        });
        if !primary_is_hardware {
            warnings.push(
                "no hardware encoder usable on this machine — micro-encodes run on the CPU"
                    .to_string(),
            );
        } else if fallback.is_none() {
            warnings.push(format!(
                "no CPU fallback for {} — if the hardware rejects a piece the export stops",
                primary.clone().unwrap_or_default()
            ));
        }
        encoder = primary;
    }

    if effective_mode == "copy" {
        if outcome.dropped_segments > 0 {
            warnings.push(format!(
                "{} segment(s) shorter than a GOP were dropped — use hybrid mode to keep them",
                outcome.dropped_segments
            ));
        }
        if outcome.max_snap_secs > 0.001 {
            warnings.push(format!(
                "cut points moved up to {:.2}s to land on a keyframe (stream copy, zero quality loss)",
                outcome.max_snap_secs
            ));
        }
    }

    let (audio_copy, audio_warnings) = audio_copied(info, Path::new(&req.output));
    warnings.extend(audio_warnings);

    let output_duration_secs = outcome.pieces.iter().map(|p| p.duration_secs).sum();

    Ok(ExportPlan {
        source: req.source.clone(),
        output: req.output.clone(),
        mode: effective_mode,
        duration_secs: duration,
        output_duration_secs,
        segments,
        copy_pieces: outcome.pieces.iter().filter(|p| p.kind == PieceKind::Copy).count(),
        encode_pieces: outcome
            .pieces
            .iter()
            .filter(|p| p.kind == PieceKind::Encode)
            .count(),
        encoder,
        keyframe_count: keyframes.len(),
        audio_copied: audio_copy,
        estimated_size_bytes: estimate_size(info, &outcome.pieces),
        warnings,
        pieces: outcome.pieces,
    })
}

impl ExportOptions {
    /// Same options, re-pointed at the mode the planner actually settled on.
    fn options_copy(&self, mode: &str) -> ExportOptions {
        ExportOptions {
            mode: mode.to_string(),
            align_tolerance_ms: self.align_tolerance_ms,
        }
    }
}

// ───────────────────────────── FFmpeg commands ─────────────────────────────

/// `ffmpeg` wants six-decimal timestamps; anything finer is noise, anything
/// coarser risks moving a cut.
fn time_arg(t: f64) -> String {
    format!("{t:.6}")
}

/// Arguments for one piece. `seek_start` is where the child begins reading;
/// `-t` limits how much of the source becomes this piece.
fn piece_args(
    source: &Path,
    piece: &Piece,
    out_file: &Path,
    has_audio: bool,
    audio_copied: bool,
    pix_fmt: Option<&str>,
    encoder: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
    ];

    match piece.kind {
        PieceKind::Copy => {
            // A copy starts at the keyframe the plan chose; the epsilon keeps a
            // downward-rounded timestamp from seeking a whole GOP too early.
            args.push("-ss".into());
            args.push(time_arg(piece.start + COPY_SEEK_EPS));
        }
        PieceKind::Encode => {
            // Accurate input seek: FFmpeg decodes from the previous keyframe
            // (references intact) and discards up to `start`, so the first
            // encoded frame really is `start` — an IDR, exactly where the copy
            // piece next door expects to take over.
            args.push("-ss".into());
            args.push(time_arg(piece.start));
        }
    }
    args.push("-i".into());
    args.push(source.to_string_lossy().into_owned());

    args.push("-t".into());
    args.push(time_arg(piece.duration_secs));
    args.push("-map".into());
    args.push("0:v:0".into());
    if has_audio {
        args.push("-map".into());
        args.push("0:a:0".into());
    }

    match piece.kind {
        PieceKind::Copy => {
            args.push("-c:v".into());
            args.push("copy".into());
        }
        PieceKind::Encode => {
            let enc = encoder.unwrap_or("libx264");
            args.push("-c:v".into());
            args.push(enc.to_string());
            args.extend(encoder_args(enc));
            if let Some(fmt) = pix_fmt {
                args.push("-pix_fmt".into());
                args.push(fmt.to_string());
            }
        }
    }

    // Audio treatment is global — every piece must carry the same codec or the
    // concat demuxer would have to stitch AAC into PCM.
    if has_audio {
        args.push("-c:a".into());
        if audio_copied {
            args.push("copy".into());
        } else {
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
    }

    // Pieces always start at zero so the concat can stack them head to tail.
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());

    args.push(out_file.to_string_lossy().into_owned());
    args
}

/// Per-encoder quality settings. Micro-encodes are 1–2 s long, so quality is
/// set generously — the CPU cost is irrelevant, the boundary fidelity is not.
fn encoder_args(encoder: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    let add = |v: &mut Vec<String>, k: &str, val: &str| {
        v.push(k.to_string());
        v.push(val.to_string());
    };
    match encoder {
        "libx264" => add(&mut v, "-crf", "17"),
        "libx265" => add(&mut v, "-crf", "20"),
        "h264_qsv" | "hevc_qsv" => {
            add(&mut v, "-preset", "medium");
            add(&mut v, "-global_quality", "22");
        }
        "h264_nvenc" | "hevc_nvenc" => {
            add(&mut v, "-preset", "p4");
            add(&mut v, "-rc", "vbr");
            add(&mut v, "-cq", "23");
        }
        "h264_amf" | "hevc_amf" => {
            add(&mut v, "-usage", "transcoding");
            add(&mut v, "-quality", "quality");
        }
        _ => {}
    }
    v
}

/// The concat demuxer invocation: reads the list, copies everything, reports
/// progress on stdout.
fn concat_args(list: &Path, has_audio: bool, output: &Path) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-f".into(),
        "concat".into(),
        "-safe".into(),
        "0".into(),
        "-i".into(),
        list.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0".into(),
    ];
    if has_audio {
        args.push("-map".into());
        args.push("0:a:0".into());
    }
    args.push("-c".into());
    args.push("copy".into());
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(output.to_string_lossy().into_owned());
    args
}

// ───────────────────────────── the run ─────────────────────────────

fn emit(app: &tauri::AppHandle, progress: ExportProgress) {
    let _ = app.emit(EXPORT_EVENT, progress);
}

fn cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

/// Open the SQLite side of the export: the transcript DB doubles as the
/// keyframe cache home. Failure degrades to "rescan the source every time",
/// never to a dead export, so the warning travels back to the panel instead.
pub fn open_cache_db(db_path: Option<&str>) -> (Option<rusqlite::Connection>, Option<String>) {
    let Some(path) = db_path else {
        return (None, None);
    };
    match transcript::open_db(Path::new(path)) {
        Ok(conn) => match keyframes::init_cache_schema(&conn) {
            Ok(()) => (Some(conn), None),
            Err(e) => (None, Some(format!("keyframe cache disabled: {e}"))),
        },
        Err(e) => (None, Some(format!("keyframe cache disabled: {e}"))),
    }
}

/// Everything `plan_export` needs: probe → keyframe map (cached) → recipe.
/// Also the first half of a real run, so the preview cannot drift from what
/// the render will do.
pub fn prepare(
    req: &ExportRequest,
    cancel: Option<Arc<AtomicBool>>,
    on_scan: Option<&dyn Fn(&str)>,
) -> Result<(MediaInfo, ExportPlan, Vec<String>), String> {
    let source = PathBuf::from(&req.source);
    if !source.exists() {
        return Err(format!("source not found: {}", req.source));
    }
    // Probe first: a broken file must fail in milliseconds, not after a
    // full-length keyframe scan.
    let info = MediaInfo::probe(&source)?;

    let (db, db_warning) = open_cache_db(req.db_path.as_deref());
    let kfs = keyframes::keyframes_for(&source, db.as_ref(), cancel)?;
    if let Some(msg) = on_scan {
        msg(&format!("{} keyframes", kfs.len()));
    }

    let plan = build_plan(req, &info, &kfs)?;
    let mut warnings: Vec<String> = Vec::new();
    if let Some(w) = db_warning {
        warnings.push(w);
    }
    warnings.extend(plan.warnings.iter().cloned());
    Ok((info, plan, warnings))
}

/// Plan, cut, concat, verify, clean up. Runs on a blocking thread (see the
/// `start_export` command) so the WebView stays responsive.
pub fn run_export(
    app: tauri::AppHandle,
    cancel: Arc<AtomicBool>,
    req: ExportRequest,
) -> Result<ExportResult, String> {
    let source = PathBuf::from(&req.source);
    if !source.exists() {
        return Err(format!("source not found: {}", req.source));
    }
    let output = PathBuf::from(&req.output);
    if output.as_path() == source.as_path() {
        return Err("output path must differ from the source".to_string());
    }
    if output.extension().is_none() {
        return Err("output path needs a file extension (.mp4 or .mkv)".to_string());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create output folder {}: {e}", parent.display()))?;
    }
    if req.segments.is_empty() {
        return Err("nothing to export — no kept segments".to_string());
    }

    // 1 ── probe → keyframe map (SQLite-cached across runs) → recipe.
    emit(
        &app,
        ExportProgress {
            stage: "scan".into(),
            piece_index: 0,
            piece_count: 0,
            percent: 0.0,
            message: "scanning keyframes…".into(),
        },
    );
    let scan_app = app.clone();
    let on_scan = move |msg: &str| {
        emit(
            &scan_app,
            ExportProgress {
                stage: "scan".into(),
                piece_index: 0,
                piece_count: 0,
                percent: 0.0,
                message: msg.to_string(),
            },
        );
    };
    let (info, plan, mut warnings) = prepare(&req, Some(Arc::clone(&cancel)), Some(&on_scan))?;
    if cancelled(&cancel) {
        return Err("export cancelled".to_string());
    }

    // 2 ── cut every piece into a work folder beside the destination, then
    // stitch them with the concat demuxer.
    let work = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .join(".t9export");
    if let Err(e) = reset_work_dir(&work) {
        return Err(format!("could not prepare work folder {}: {e}", work.display()));
    }

    let result = cut_and_concat(
        &app,
        &cancel,
        &source,
        &plan,
        &info,
        &work,
        &output,
        &mut warnings,
    );

    if let Err(e) = result {
        // Never leave gigabytes of intermediates behind, whatever happened.
        let _ = std::fs::remove_dir_all(&work);
        if cancelled(&cancel) || e == "export cancelled" {
            return Err("export cancelled".to_string());
        }
        return Err(e);
    }

    if let Err(e) = std::fs::remove_dir_all(&work) {
        warnings.push(format!("could not remove work folder: {e}"));
    }

    // 3 ── verify: the output must be probe-able and roughly the duration the
    // planner promised.
    let out_info = MediaInfo::probe(&output)
        .map_err(|e| format!("export finished but the output could not be probed: {e}"))?;
    let expected = plan.output_duration_secs;
    if (out_info.duration_secs - expected).abs() > expected.max(1.0) * 0.05 + 1.0 {
        warnings.push(format!(
            "output duration {:.2}s differs from the planned {:.2}s — check the cut points",
            out_info.duration_secs, expected
        ));
    }

    emit(
        &app,
        ExportProgress {
            stage: "done".into(),
            piece_index: plan.pieces.len(),
            piece_count: plan.pieces.len(),
            percent: 100.0,
            message: "done".into(),
        },
    );

    Ok(ExportResult {
        output: output.to_string_lossy().into_owned(),
        duration_secs: out_info.duration_secs,
        size_bytes: out_info.size_bytes,
        piece_count: plan.pieces.len(),
        encoder: plan.encoder.clone(),
        warnings,
    })
}

/// Empty-or-create the per-run folder that holds the intermediate pieces.
fn reset_work_dir(work: &Path) -> std::io::Result<()> {
    if work.exists() {
        std::fs::remove_dir_all(work)?;
    }
    std::fs::create_dir_all(work)
}

/// Phase 2 and 3: cut every piece, then stitch them.
#[allow(clippy::too_many_arguments)]
fn cut_and_concat(
    app: &tauri::AppHandle,
    cancel: &Arc<AtomicBool>,
    source: &Path,
    plan: &ExportPlan,
    info: &MediaInfo,
    work: &Path,
    output: &Path,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    let total_dur: f64 = plan.pieces.iter().map(|p| p.duration_secs).sum();
    let total_dur = if total_dur > 0.0 { total_dur } else { 1.0 };
    let piece_count = plan.pieces.len();
    let has_audio = info.has_audio;
    let mut done_dur = 0.0f64;
    let mut used_encoder = plan.encoder.clone();

    for piece in &plan.pieces {
        if cancelled(cancel) {
            return Err("export cancelled".to_string());
        }
        let file = work.join(format!("piece_{:04}.mkv", piece.index));
        let base = WEIGHT_CUT * done_dur / total_dur;

        emit(
            app,
            ExportProgress {
                stage: "cut".into(),
                piece_index: piece.index + 1,
                piece_count,
                percent: base,
                message: match piece.kind {
                    PieceKind::Copy => format!("copying {}s", round2(piece.duration_secs)),
                    PieceKind::Encode => format!("encoding {}s", round2(piece.duration_secs)),
                },
            },
        );

        let encoder_for_piece = used_encoder.clone();
        let mut out = run_piece(
            app,
            cancel,
            piece,
            &file,
            source,
            info,
            plan,
            encoder_for_piece.as_deref(),
            base,
            total_dur,
        )?;

        // A hardware encoder can still refuse a real GOP even after passing the
        // synthetic probe (driver quirk, 10-bit source on an 8-bit chip). Fall
        // back to the CPU encoder for the rest of the run instead of failing a
        // render that is already minutes in.
        if !out.success() && piece.kind == PieceKind::Encode {
            let fallback = plan_fallback(plan);
            if let Some(fb) = fallback {
                warnings.push(format!(
                    "{} failed on piece {} ({}); falling back to {fb} for the rest of the export",
                    used_encoder.clone().unwrap_or_default(),
                    piece.index + 1,
                    out.stderr_tail.lines().next().unwrap_or("unknown error").trim()
                ));
                used_encoder = Some(fb.clone());
                emit(
                    app,
                    ExportProgress {
                        stage: "cut".into(),
                        piece_index: piece.index + 1,
                        piece_count,
                        percent: base,
                        message: format!("retrying with {fb}…"),
                    },
                );
                out = run_piece(
                    app,
                    cancel,
                    piece,
                    &file,
                    source,
                    info,
                    plan,
                    Some(&fb),
                    base,
                    total_dur,
                )?;
            }
        }

        if out.cancelled || cancelled(cancel) {
            return Err("export cancelled".to_string());
        }
        if !out.success() {
            return Err(format!(
                "piece {}/{} failed (exit {}): {}",
                piece.index + 1,
                piece_count,
                out.status,
                out.stderr_tail.trim()
            ));
        }
        done_dur += piece.duration_secs;
    }

    if cancelled(cancel) {
        return Err("export cancelled".to_string());
    }

    // ── concat ──────────────────────────────────────────────────────────
    let paths: Vec<PathBuf> = (0..piece_count)
        .map(|i| work.join(format!("piece_{i:04}.mkv")))
        .collect();
    let list = work.join("list.txt");
    std::fs::write(&list, concat_list_text(&paths))
        .map_err(|e| format!("could not write concat list: {e}"))?;

    emit(
        app,
        ExportProgress {
            stage: "concat".into(),
            piece_index: piece_count,
            piece_count,
            percent: WEIGHT_CUT,
            message: "stitching pieces…".into(),
        },
    );

    let args = concat_args(&list, has_audio, output);
    let mut last = 0.0f64;
    let out = run_streaming("ffmpeg", &args, Some(Arc::clone(cancel)), |line| {
        if let Some(ProgressLine::OutTime(t)) = parse_progress_line(line) {
            last = t;
        }
        if last > 0.0 {
            let local = ((last / total_dur) * 100.0).clamp(0.0, 100.0);
            emit(
                app,
                ExportProgress {
                    stage: "concat".into(),
                    piece_index: piece_count,
                    piece_count,
                    percent: WEIGHT_CUT + WEIGHT_CONCAT * local / 100.0,
                    message: format!("stitching {} / {}s", round2(last), round2(total_dur)),
                },
            );
        }
    })?;

    if out.cancelled || cancelled(cancel) {
        return Err("export cancelled".to_string());
    }
    if out.status != 0 {
        return Err(format!(
            "concat failed (exit {}): {}",
            out.status,
            out.stderr_tail.trim()
        ));
    }
    Ok(())
}

/// CPU encoder for the current family, when one exists — the escape hatch when
/// hardware rejects a piece.
fn plan_fallback(plan: &ExportPlan) -> Option<String> {
    let primary = plan.encoder.as_deref()?;
    let cpu = if primary.contains("265") || primary.contains("hevc") {
        "libx265"
    } else {
        "libx264"
    };
    if cpu == primary {
        return None;
    }
    (ffmpeg_has_encoder(cpu) && ffmpeg_encoder_usable(cpu)).then(|| cpu.to_string())
}

/// Run one piece and stream its progress into the shared bar.
fn run_piece(
    app: &tauri::AppHandle,
    cancel: &Arc<AtomicBool>,
    piece: &Piece,
    file: &Path,
    source: &Path,
    info: &MediaInfo,
    plan: &ExportPlan,
    encoder: Option<&str>,
    base: f64,
    total_dur: f64,
) -> Result<crate::ffmpeg::StreamOutput, String> {
    let args = piece_args(
        source,
        piece,
        file,
        info.has_audio,
        plan.audio_copied,
        info.pix_fmt.as_deref(),
        encoder,
    );
    let piece_dur = piece.duration_secs.max(0.001);
    let mut last_out = 0.0f64;
    let piece_index = piece.index + 1;
    let piece_count = plan.pieces.len();

    let out = run_streaming("ffmpeg", &args, Some(Arc::clone(cancel)), |line| {
        if let Some(ProgressLine::OutTime(t)) = parse_progress_line(line) {
            last_out = t;
        }
        let local = ((last_out / piece_dur) * 100.0).clamp(0.0, 100.0);
        let percent = base + (WEIGHT_CUT / total_dur) * piece_dur * local / 100.0;
        let label = match piece.kind {
            PieceKind::Copy => format!("copying {piece_index}/{piece_count}"),
            PieceKind::Encode => format!("encoding {piece_index}/{piece_count}"),
        };
        emit(
            app,
            ExportProgress {
                stage: "cut".into(),
                piece_index,
                piece_count,
                percent,
                message: label,
            },
        );
    })?;
    Ok(out)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kfs() -> Vec<f64> {
        vec![0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0]
    }

    fn opts(mode: &str) -> ExportOptions {
        ExportOptions {
            mode: mode.to_string(),
            align_tolerance_ms: 40.0,
        }
    }

    #[test]
    fn aligned_cut_is_a_single_copy_piece() {
        let seg = [Segment {
            start: 2.0,
            end: 8.0,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("hybrid"));
        assert_eq!(out.pieces.len(), 1);
        assert_eq!(out.pieces[0].kind, PieceKind::Copy);
        assert_eq!(out.pieces[0].start, 2.0);
        assert_eq!(out.pieces[0].end, 8.0, "a copy piece may end mid-GOP");
    }

    #[test]
    fn mid_gop_start_encodes_only_the_partial_gop() {
        let seg = [Segment {
            start: 3.0,
            end: 9.5,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("hybrid"));
        assert_eq!(out.pieces.len(), 2);
        assert_eq!(out.pieces[0].kind, PieceKind::Encode);
        assert_eq!(out.pieces[0].start, 3.0);
        assert_eq!(out.pieces[0].end, 4.0, "partial GOP only — 1 s, not 6.5");
        assert_eq!(out.pieces[1].kind, PieceKind::Copy);
        assert_eq!(out.pieces[1].start, 4.0);
        assert_eq!(out.pieces[1].end, 9.5);
    }

    #[test]
    fn segment_inside_one_gop_encodes_whole() {
        let seg = [Segment {
            start: 4.5,
            end: 5.5,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("hybrid"));
        assert_eq!(out.pieces.len(), 1);
        assert_eq!(out.pieces[0].kind, PieceKind::Encode);
        assert_eq!(out.pieces[0].start, 4.5);
        assert_eq!(out.pieces[0].end, 5.5);
    }

    #[test]
    fn micro_tolerance_snaps_instead_of_encoding() {
        // 10 ms off a keyframe: well inside the 40 ms tolerance.
        let seg = [Segment {
            start: 4.01,
            end: 7.99,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("hybrid"));
        assert_eq!(out.pieces.len(), 1, "expected a plain copy, got {out:#?}");
        assert_eq!(out.pieces[0].kind, PieceKind::Copy);
        assert_eq!(out.pieces[0].start, 4.0);
        assert_eq!(out.pieces[0].end, 8.0);
        assert!(out.max_snap_secs <= 0.011, "snap {}", out.max_snap_secs);
    }

    #[test]
    fn copy_mode_never_leaks_cut_content() {
        // Segment starts mid-GOP: copy mode must begin *after* it, at the next
        // keyframe, rather than pulling the previous GOP's frames back in.
        let seg = [Segment {
            start: 3.0,
            end: 9.5,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("copy"));
        assert_eq!(out.pieces.len(), 1);
        assert_eq!(out.pieces[0].kind, PieceKind::Copy);
        assert_eq!(out.pieces[0].start, 4.0, "must not start before s");
        assert_eq!(out.pieces[0].end, 8.0, "must not reach past e");
        assert!(out.max_snap_secs > 0.9, "snap should be reported");
    }

    #[test]
    fn copy_mode_drops_segments_shorter_than_a_gop() {
        let seg = [Segment {
            start: 4.5,
            end: 5.5,
        }];
        let out = plan_pieces(&seg, &kfs(), &opts("copy"));
        assert!(out.pieces.is_empty());
        assert_eq!(out.dropped_segments, 1);
    }

    #[test]
    fn encode_mode_keeps_exact_boundaries() {
        let seg = [
            Segment {
                start: 1.234,
                end: 5.678,
            },
            Segment {
                start: 9.0,
                end: 10.0,
            },
        ];
        let out = plan_pieces(&seg, &kfs(), &opts("encode"));
        assert_eq!(out.pieces.len(), 2);
        assert!(out.pieces.iter().all(|p| p.kind == PieceKind::Encode));
        assert_eq!(out.pieces[0].start, 1.234);
        assert_eq!(out.pieces[0].end, 5.678);
        assert_eq!(out.pieces[1].segment_index, 1);
    }

    #[test]
    fn multiple_segments_produce_contiguous_piece_indices() {
        let seg = [
            Segment {
                start: 0.5,
                end: 3.5,
            },
            Segment {
                start: 6.0,
                end: 11.25,
            },
        ];
        let out = plan_pieces(&seg, &kfs(), &opts("hybrid"));
        assert_eq!(
            out.pieces.iter().map(|p| p.index).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        // Piece 1 is the copy half of segment 0; piece 2 starts segment 1.
        assert_eq!(out.pieces[1].segment_index, 0);
        assert_eq!(out.pieces[2].segment_index, 1);
        assert_eq!(out.pieces[2].start, 6.0);
    }

    #[test]
    fn normalise_adds_file_start_and_end_and_sorts() {
        let norm = normalise_keyframes(vec![6.0, 2.0], 12.5);
        assert_eq!(norm, vec![0.0, 2.0, 6.0, 12.5]);
    }

    #[test]
    fn normalise_survives_empty_input() {
        let norm = normalise_keyframes(vec![], 10.0);
        assert_eq!(norm, vec![0.0, 10.0]);
        assert_eq!(normalise_keyframes(vec![], 0.0), vec![0.0]);
    }

    #[test]
    fn concat_list_escapes_windows_paths() {
        let paths = vec![
            PathBuf::from(r"C:\Users\Dev\My Video\piece_0000.mkv"),
            PathBuf::from(r"C:\temp\it's here\piece_0001.mkv"),
        ];
        let text = concat_list_text(&paths);
        assert!(text.starts_with("ffconcat version 1.0\n"));
        assert!(
            text.contains("file 'C:/Users/Dev/My Video/piece_0000.mkv'"),
            "backslashes must be flattened: {text}"
        );
        assert!(
            text.contains(r"file 'C:/temp/it'\''s here/piece_0001.mkv'"),
            "quote must be escaped: {text}"
        );
    }

    #[test]
    fn progress_lines_parse_out_time_not_the_ms_quirk() {
        assert_eq!(
            parse_progress_line("out_time=00:01:30.500000"),
            Some(ProgressLine::OutTime(90.5))
        );
        assert_eq!(
            parse_progress_line("out_time=00:00:00.000000"),
            Some(ProgressLine::OutTime(0.0))
        );
        // out_time_ms is in microseconds — deliberately not parsed.
        assert_eq!(parse_progress_line("out_time_ms=90500000"), None);
        assert_eq!(parse_progress_line("out_time_us=90500000"), None);
        assert_eq!(
            parse_progress_line("speed=2.5x"),
            Some(ProgressLine::Speed(2.5))
        );
        assert_eq!(
            parse_progress_line("progress=continue"),
            Some(ProgressLine::Status("continue".into()))
        );
        assert_eq!(parse_progress_line("frame=123"), None);
        assert_eq!(parse_progress_line("out_time=N/A"), None);
        assert_eq!(parse_progress_line("garbage"), None);
    }

    #[test]
    fn piece_args_start_with_seek_and_limit_duration() {
        let piece = Piece {
            index: 0,
            segment_index: 0,
            start: 3.0,
            end: 4.0,
            kind: PieceKind::Encode,
            duration_secs: 1.0,
        };
        let args = piece_args(
            Path::new("C:\\src\\v.mp4"),
            &piece,
            Path::new("C:\\out\\piece_0000.mkv"),
            true,
            true,
            Some("yuv420p"),
            Some("h264_qsv"),
        );
        let joined = args.join(" ");
        assert!(joined.contains("-ss 3.000000"), "{joined}");
        assert!(joined.contains("-t 1.000000"), "{joined}");
        assert!(joined.contains("-map 0:v:0"), "{joined}");
        assert!(joined.contains("-map 0:a:0"), "{joined}");
        assert!(joined.contains("-c:v h264_qsv"), "{joined}");
        assert!(joined.contains("-global_quality 22"), "{joined}");
        assert!(joined.contains("-pix_fmt yuv420p"), "{joined}");
        assert!(joined.ends_with("C:\\out\\piece_0000.mkv"), "{joined}");
    }

    #[test]
    fn copy_piece_seeks_a_microsecond_past_the_keyframe() {
        let piece = Piece {
            index: 1,
            segment_index: 0,
            start: 4.0,
            end: 9.5,
            kind: PieceKind::Copy,
            duration_secs: 5.5,
        };
        let args = piece_args(
            Path::new("v.mp4"),
            &piece,
            Path::new("piece_0001.mkv"),
            false,
            true,
            None,
            None,
        );
        let joined = args.join(" ");
        assert!(joined.contains("-ss 4.000001"), "{joined}");
        assert!(joined.contains("-c:v copy"), "{joined}");
        assert!(!joined.contains("-c:v h264"), "a copy piece must not encode: {joined}");
        assert!(!joined.contains("-map 0:a:0"), "no audio mapped: {joined}");
    }

    #[test]
    fn concat_args_copy_everything_and_report_progress() {
        let args = concat_args(Path::new("list.txt"), true, Path::new("out.mp4"));
        let joined = args.join(" ");
        assert!(joined.contains("-f concat"), "{joined}");
        assert!(joined.contains("-safe 0"), "{joined}");
        assert!(joined.contains("-c copy"), "{joined}");
        assert!(joined.contains("-progress pipe:1"), "{joined}");
        assert!(joined.contains("-nostats"), "{joined}");
        assert!(joined.ends_with("out.mp4"), "{joined}");
    }

    #[test]
    fn estimate_counts_copy_at_full_share_and_encode_lower() {
        let info = MediaInfo {
            path: "v.mp4".into(),
            duration_secs: 10.0,
            size_bytes: 1_000,
            fps: Some(30.0),
            width: Some(1920),
            height: Some(1080),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            pix_fmt: Some("yuv420p".into()),
            has_audio: true,
            streams: vec![],
        };
        let pieces = vec![
            Piece {
                index: 0,
                segment_index: 0,
                start: 0.0,
                end: 5.0,
                kind: PieceKind::Copy,
                duration_secs: 5.0,
            },
            Piece {
                index: 1,
                segment_index: 0,
                start: 5.0,
                end: 6.0,
                kind: PieceKind::Encode,
                duration_secs: 1.0,
            },
        ];
        // 5 s copy = 500 B, 1 s encode = 100 B × 0.7 = 70 B.
        assert_eq!(estimate_size(&info, &pieces), 570);
    }

    #[test]
    fn options_defaults_to_hybrid_with_40ms_tolerance() {
        let d = ExportOptions::default();
        assert_eq!(d.mode, "hybrid");
        assert_eq!(d.align_tolerance_ms, 40.0);
    }
}
