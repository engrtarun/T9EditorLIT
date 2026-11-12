//! Audio extraction and chunking (Chunk 2, step 2).
//!
//! FFmpeg pulls a mono 16 kHz PCM track out of the source and segments it into
//! ~15 MB (default 300 s) WAV chunks. The 5 GB video is never loaded into
//! this process's address space; only short-lived child processes touch it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pub index: usize,
    pub path: String,
    pub offset_secs: f64,
    pub duration_secs: f64,
}

/// Probe a single media file's duration in seconds via ffprobe.
pub fn probe_duration(path: &Path) -> Result<f64, String> {
    let out = crate::ffmpeg::silent("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("failed to spawn ffprobe: {e}"))?;

    if !out.status.success() {
        return Err(format!(
            "ffprobe failed ({}): {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim()
        .parse::<f64>()
        .map_err(|e| format!("could not parse duration {:?}: {e}", s.trim()))
}

/// True for the `chunk_000.wav` files this module produces (and no others).
fn is_chunk_wav(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("wav")
        && path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with("chunk_"))
            .unwrap_or(false)
}

/// Hard ceiling for one chunk: Groq refuses uploads over 25 MB, and mono
/// 16 kHz 16-bit PCM is 32 kB/s. 760 s ≈ 24.3 MB, leaving room for the WAV
/// header and for the overlap padding on both edges.
pub const MAX_SEGMENT_SECS: f64 = 760.0;

/// One contiguous slice of the source, in source seconds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChunkSpan {
    pub start: f64,
    pub end: f64,
}

/// Cut a source into speech-aware spans.
///
/// The old chunker cut blindly every `segment_secs`, which split words in half
/// and transcribed the silence between chapters. This planner uses the
/// `silencedetect` ranges as *boundaries only*:
///
/// * a span always starts and ends in speech, so leading/trailing dead air is
///   never uploaded (a 49-minute file whose first minute is silence saves that
///   minute on every call),
/// * a cut lands in the middle of a silence range, never inside a word,
/// * each span is `target_secs` long (±20 %) and never exceeds
///   [`MAX_SEGMENT_SECS`], so the 25 MB limit cannot be crossed,
/// * adjacent spans overlap by `overlap_secs` on **both** sides, giving the
///   reconciler real audio evidence on each side of a boundary.
///
/// Deterministic: the same duration + silence ranges always produce the same
/// spans, so a retry re-extracts exactly the chunk that failed.
pub fn plan_spans(
    duration: f64,
    silences: &[SilenceRange],
    target_secs: f64,
    overlap_secs: f64,
) -> Vec<ChunkSpan> {
    let duration = duration.max(0.0);
    if duration <= 0.0 {
        return Vec::new();
    }
    let target = target_secs.clamp(30.0, MAX_SEGMENT_SECS);
    let overlap = overlap_secs.clamp(0.0, 2.0).min(target / 4.0);
    let max = (target * 1.2).min(MAX_SEGMENT_SECS);

    // Merge the silence ranges, clamped to this media file.
    let mut ranges: Vec<(f64, f64)> = silences
        .iter()
        .map(|r| (r.start.max(0.0), r.end.min(duration)))
        .filter(|(start, end)| end > start)
        .collect();
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut()
            && start <= last.1 + 0.05
        {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }

    // Speech is the complement of silence. Only the edges are trimmed; the
    // audio *inside* a span stays contiguous, so `offsetSecs` remains a plain
    // source-time mapping (no concat map to drift).
    let mut speech: Vec<(f64, f64)> = Vec::new();
    let mut cursor = 0.0;
    for (start, end) in &merged {
        if *start > cursor + 0.05 {
            speech.push((cursor, *start));
        }
        cursor = cursor.max(*end);
    }
    if duration > cursor + 0.05 {
        speech.push((cursor, duration));
    }
    if speech.is_empty() {
        // Silence everywhere: hand the whole file to the transcriber so the
        // daemon can answer "no speech" instead of the app producing nothing.
        return vec![ChunkSpan {
            start: 0.0,
            end: duration,
        }];
    }

    let mut spans: Vec<ChunkSpan> = Vec::new();
    let push = |start: f64, end: f64, spans: &mut Vec<ChunkSpan>| {
        let start = (start - overlap).max(0.0);
        let end = (end + overlap).min(duration);
        if end - start > 0.05 {
            spans.push(ChunkSpan {
                start: round3(start),
                end: round3(end),
            });
        }
    };

    let mut current: Option<(f64, f64)> = None;
    for (start, end) in speech {
        // A single speech run longer than the ceiling is split at the ceiling;
        // there is no silence to cut on, so the overlap is the only guard.
        if end - start > max {
            if let Some((cs, ce)) = current.take() {
                push(cs, ce, &mut spans);
            }
            let mut piece = start;
            while end - piece > max {
                let cut = (piece + max).min(end);
                push(piece, cut, &mut spans);
                piece = cut - overlap;
                if cut >= end {
                    break;
                }
            }
            if end - piece > 0.05 {
                push(piece, end, &mut spans);
            }
            continue;
        }
        match current {
            None => current = Some((start, end)),
            Some((cs, ce)) => {
                // Close on target when the next speech starts after a real
                // silence, or force-close before the ceiling.
                if end - cs > max || ce - cs >= target {
                    push(cs, ce, &mut spans);
                    current = Some((start, end));
                } else {
                    current = Some((cs, end));
                }
            }
        }
    }
    if let Some((cs, ce)) = current {
        push(cs, ce, &mut spans);
    }
    spans
}

/// Extract mono 16 kHz audio and split it into speech-aware chunks.
///
/// Each span is pulled by its own short-lived FFmpeg child (`-ss` fast seek),
/// so the source is never decoded twice and the process never holds more than
/// the child's stderr. Returns the ordered chunk files with their **original**
/// source offsets.
///
/// `source_hash` is a short hash of the source path used to create a per-source
/// chunk directory so runs for different videos never collide on disk.
///
/// `on_progress(done, expected)` is called once per finished span: the user
/// sees a real counter after every chunk instead of one frozen percentage.
pub fn extract_chunks(
    source: &Path,
    out_dir: &Path,
    segment_secs: f64,
    source_hash: &str,
    on_progress: &mut dyn FnMut(usize, usize),
) -> Result<Vec<AudioChunk>, String> {
    if !source.exists() {
        return Err(format!("source file not found: {}", source.display()));
    }
    let segment_secs = if segment_secs <= 0.0 {
        300.0
    } else {
        segment_secs.min(MAX_SEGMENT_SECS)
    };

    // Per-source subdirectory so different videos' chunks never collide.
    let chunk_dir = out_dir.join(source_hash);
    fs::create_dir_all(&chunk_dir)
        .map_err(|e| format!("could not create chunk dir {}: {e}", chunk_dir.display()))?;

    // Clean stale chunks from a previous run of this same source so we never
    // mix old and new. Other sources' chunks are left untouched.
    if let Ok(entries) = fs::read_dir(&chunk_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if is_chunk_wav(&p) {
                let _ = fs::remove_file(p);
            }
        }
    }

    let duration = probe_duration(source)?;
    // One silencedetect pass (audio only, no output file). A failure must not
    // lose the transcription: fall back to even, speech-blind spans.
    let silences = detect_silence(source, -35.0, 0.35).unwrap_or_default();
    let spans = plan_spans(duration, &silences, segment_secs, 0.6);
    if spans.is_empty() {
        return Err("could not plan any audio chunk for this source".to_string());
    }

    let expected = spans.len();
    on_progress(0, expected);

    for (index, span) in spans.iter().enumerate() {
        let path = chunk_dir.join(format!("chunk_{index:03}.wav"));
        let start = format!("{:.3}", span.start);
        let length = format!("{:.3}", (span.end - span.start).max(0.05));
        let child = crate::ffmpeg::silent("ffmpeg")
            .args([
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-ss",
                &start,
                "-i",
            ])
            .arg(source)
            .args([
                "-t",
                &length,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
        // Case 10: a power loss / Task Manager kill must not leave this child
        // decoding a 5 GB file with no parent.
        crate::ffmpeg::adopt(&child);
        let output = child
            .wait_with_output()
            .map_err(|e| format!("waiting for ffmpeg: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "ffmpeg audio extraction failed for chunk {index}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        on_progress(index + 1, expected);
    }

    let mut chunks = Vec::with_capacity(spans.len());
    for (index, span) in spans.iter().enumerate() {
        let path = chunk_dir.join(format!("chunk_{index:03}.wav"));
        if !path.is_file() {
            return Err(format!("ffmpeg produced no file for chunk {index}"));
        }
        chunks.push(AudioChunk {
            index,
            path: path.to_string_lossy().into_owned(),
            offset_secs: round3(span.start),
            duration_secs: round3(span.end - span.start),
        });
    }
    Ok(chunks)
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// The per-source chunk subdirectory name.
///
/// `Some(key)` arrives from the webview (its own hash of the source path, hex),
/// so it goes through [`sanitize_chunk_key`] before it may touch the
/// filesystem. `None` covers callers that never send a key: an in-process hash
/// of the source path keeps *those* per-source isolated too, with no frontend
/// change — two different videos can no longer share one chunks directory.
pub fn chunk_key(source_key: Option<&str>, source_path: &str) -> String {
    match source_key {
        Some(key) => sanitize_chunk_key(key),
        None => {
            use std::collections::hash_map::DefaultHasher;
            use std::hash::{Hash, Hasher};
            let mut h = DefaultHasher::new();
            source_path.hash(&mut h);
            format!("auto-{:016x}", h.finish())
        }
    }
}

/// A renderer-supplied subdirectory name, made filesystem-safe.
///
/// Only `[A-Za-z0-9_-]` survives and the name is capped at 64 bytes, so a key
/// can never carry a path separator or become `..\..` by joining. Real keys
/// are 8 hex characters, making this a no-op for everything the frontend sends.
pub fn sanitize_chunk_key(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// A detected silent span in the source audio.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SilenceRange {
    pub start: f64,
    pub end: f64,
}

/// Detect silent spans in a source using FFmpeg's `silencedetect` filter.
///
/// Streams the audio through a throwaway FFmpeg child (no video decode, no
/// output file), so a 5 GB source never lands in this process's heap. Only
/// the silence markers on stderr are parsed into ranges.
///
/// `noise_db` is the RMS threshold in dB — speech above it counts as sound;
/// anything below for at least `min_secs` counts as silence. `min_secs` is
/// the floor on what counts as "dead air": short inter-sentence breaths stay
/// so the result feels natural rather than clipped.
pub fn detect_silence(
    source: &Path,
    noise_db: f64,
    min_secs: f64,
) -> Result<Vec<SilenceRange>, String> {
    if !source.exists() {
        return Err(format!("source file not found: {}", source.display()));
    }
    let p = source.to_string_lossy().into_owned();
    let noise = format!("{noise_db}");
    let min = format!("{min_secs}");
    let filter = format!("silencedetect=noise={noise}dB:d={min}");

    // `-map 0:a:0` decodes only the first audio track and `-f null -` discards
    // the output, so this is a fast pass, not a render.
    //
    // silencedetect reports every marker on stderr, so this pass needs the full
    // stderr (not the bounded tail ffmpeg::run keeps) -- run the child directly.
    let output = crate::ffmpeg::silent("ffmpeg")
        .args([
            "-hide_banner",
            "-nostdin",
            "-i",
            &p,
            "-map",
            "0:a:0",
            "-af",
            &filter,
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    // FFmpeg reports silence on stderr; a non-zero status here (e.g. no audio
    // stream) yields no markers, which we surface as an empty result.
    let total = probe_duration(source).unwrap_or(0.0);
    let stderr = String::from_utf8_lossy(&output.stderr);
    Ok(parse_silence_markers(&stderr, total))
}

/// Parse `silence_start` / `silence_end` markers emitted by `silencedetect`.
fn parse_silence_markers(stderr: &str, total_secs: f64) -> Vec<SilenceRange> {
    let mut ranges: Vec<SilenceRange> = Vec::new();
    let mut pending_start: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(rest) = line.split("silence_start:").nth(1) {
            if let Some(v) = rest
                .split_whitespace()
                .next()
                .and_then(|t| t.parse::<f64>().ok())
            {
                pending_start = Some(v);
            }
        } else if let Some(rest) = line.split("silence_end:").nth(1) {
            if let Some(end) = rest
                .split_whitespace()
                .next()
                .and_then(|t| t.parse::<f64>().ok())
            {
                if let Some(start) = pending_start.take() {
                    // A marker pair with end <= start is noise, not a range.
                    if end > start {
                        ranges.push(SilenceRange {
                            start: round3(start),
                            end: round3(end),
                        });
                    }
                }
            }
        }
    }

    // A trailing silence that runs to the end of the file never gets an
    // `silence_end` marker; close it against the media duration.
    if let Some(start) = pending_start {
        if total_secs > start {
            ranges.push(SilenceRange {
                start: round3(start),
                end: round3(total_secs),
            });
        }
    }

    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round3_trims_noise() {
        assert_eq!(round3(1.234567), 1.235);
        assert_eq!(round3(0.0), 0.0);
    }

    #[test]
    fn chunk_keys_never_carry_path_syntax() {
        assert_eq!(sanitize_chunk_key(""), "default");
        assert_eq!(sanitize_chunk_key("3f9d2c81"), "3f9d2c81");
        assert_eq!(sanitize_chunk_key("a/b\\c"), "abc");
        assert_eq!(sanitize_chunk_key(".\u{2e}\\..\\\u{77}in"), "win");
        // A 100-character key is capped, not truncated off the filesystem.
        assert_eq!(sanitize_chunk_key(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn legacy_callers_keep_per_source_dirs_without_a_key() {
        assert_ne!(
            chunk_key(None, "D:\\videos\\one.mp4"),
            chunk_key(None, "D:\\videos\\two.mp4")
        );
        // No key the caller gives may smuggle a separator through.
        assert!(!chunk_key(None, "D:\\videos\\one.mp4").contains('\\'));
    }

    #[test]
    fn a_renderer_key_wins_when_present() {
        assert_eq!(chunk_key(Some("abc123"), "any path at all"), "abc123");
    }

    #[test]
    fn parses_silence_marker_pairs() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 4.25 | silence_duration: 2.75
[silencedetect @ 0x1] silence_start: 10
[silencedetect @ 0x1] silence_end: 12.5 | silence_duration: 2.5
";
        let ranges = parse_silence_markers(stderr, 30.0);
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].start, 1.5);
        assert_eq!(ranges[0].end, 4.25);
        assert_eq!(ranges[1].start, 10.0);
        assert_eq!(ranges[1].end, 12.5);
    }

    #[test]
    fn closes_trailing_silence_against_duration() {
        let stderr = "[silencedetect @ 0x1] silence_start: 20\n";
        let ranges = parse_silence_markers(stderr, 25.0);
        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start, 20.0);
        assert_eq!(ranges[0].end, 25.0);
    }

    #[test]
    fn ignores_inverted_markers() {
        let stderr = "\
[silencedetect @ 0x1] silence_start: 5
[silencedetect @ 0x1] silence_end: 3 | silence_duration: -2
";
        assert!(parse_silence_markers(stderr, 30.0).is_empty());
    }

    fn silence(start: f64, end: f64) -> SilenceRange {
        SilenceRange { start, end }
    }

    #[test]
    fn plan_trims_leading_and_trailing_dead_air() {
        // 60 s file: 10 s silent intro, speech, 5 s silent outro.
        let spans = plan_spans(60.0, &[silence(0.0, 10.0), silence(55.0, 60.0)], 300.0, 0.6);
        assert_eq!(spans.len(), 1);
        assert!((spans[0].start - 9.4).abs() < 0.01, "start {:?}", spans[0]);
        assert!((spans[0].end - 55.6).abs() < 0.01, "end {:?}", spans[0]);
    }

    #[test]
    fn plan_cuts_inside_silence_never_mid_speech() {
        // 900 s file with a 10 s silence straddling the 300 s target.
        let spans = plan_spans(
            900.0,
            &[silence(295.0, 315.0), silence(610.0, 625.0)],
            300.0,
            0.6,
        );
        assert!(spans.len() >= 3);
        // Every cut lies inside one of the silence ranges (with overlap both
        // sides, the boundary is still silence, never a word).
        for pair in spans.windows(2) {
            let cut = (pair[0].end + pair[1].start) / 2.0;
            assert!(
                (295.0..=315.0).contains(&cut) || (610.0..=625.0).contains(&cut),
                "cut {cut} is not inside a silence"
            );
        }
    }

    #[test]
    fn plan_never_exceeds_the_upload_ceiling() {
        // Asking for a 9999 s chunk must still obey MAX_SEGMENT_SECS.
        let spans = plan_spans(3600.0, &[], 9999.0, 0.6);
        assert!(!spans.is_empty());
        for span in &spans {
            assert!(
                span.end - span.start <= MAX_SEGMENT_SECS + 1.2,
                "span too big: {span:?}"
            );
        }
        // A one-hour file becomes a handful of chunks, not one giant upload.
        assert!(spans.len() >= 4, "got {} spans", spans.len());
    }

    #[test]
    fn plan_splits_a_single_long_speech_run() {
        // One unbroken 20-minute lecture: no silence to cut on, so the planner
        // must split at the ceiling with an overlap.
        let spans = plan_spans(1200.0, &[], 300.0, 0.6);
        assert!(spans.len() >= 4);
        for pair in spans.windows(2) {
            assert!(pair[1].start < pair[0].end, "chunks must overlap");
        }
    }

    #[test]
    fn plan_handles_a_fully_silent_file() {
        let spans = plan_spans(120.0, &[silence(0.0, 120.0)], 300.0, 0.6);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].start, 0.0);
        assert_eq!(spans[0].end, 120.0);
    }

    #[test]
    fn plan_is_deterministic_for_retries() {
        let silences = [silence(280.0, 300.0), silence(590.0, 610.0)];
        let a = plan_spans(900.0, &silences, 300.0, 0.6);
        let b = plan_spans(900.0, &silences, 300.0, 0.6);
        assert_eq!(a, b);
    }
}
