//! Audio extraction and chunking (Chunk 2, step 2).
//!
//! FFmpeg pulls a mono 16 kHz PCM track out of the source and segments it into
//! ~15 MB (default 300 s) WAV chunks. The 5 GB video is never loaded into
//! this process's address space; only short-lived child processes touch it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

/// How many chunks exist in `dir` right now.
fn count_chunks(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| entries.flatten().filter(|e| is_chunk_wav(&e.path())).count())
        .unwrap_or(0)
}

/// Extract mono 16 kHz audio and split it into chunks of at most `segment_secs`
/// seconds. Returns the ordered list of chunk files with their offsets into the
/// original video.
///
/// `source_hash` is a short hash of the source path used to create a per-source
/// chunk directory so runs for different videos never collide on disk.
///
/// `on_progress(done, expected)` is called while FFmpeg runs: the segment muxer
/// closes one file per chunk, so counting files on disk is a real measure of
/// how far the split has got. A 49-minute source spends a minute or two in this
/// stage, and a bar parked at its start value for that long is the difference
/// between "working" and "hung".
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
        segment_secs
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

    // Expected chunk count, so progress has a denominator from the first tick.
    // A probe failure is not fatal: the split still runs, only without a total.
    let expected = probe_duration(source)
        .ok()
        .map(|d| (d / segment_secs).ceil().max(1.0) as usize)
        .unwrap_or(0);

    let pattern = chunk_dir.join("chunk_%03d.wav");
    let seg_arg = format!("{segment_secs}");
    let mut child = crate::ffmpeg::silent("ffmpeg")
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "segment",
            "-segment_time",
        ])
        .arg(&seg_arg)
        .args(["-reset_timestamps", "1"])
        .arg(&pattern)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    crate::ffmpeg::adopt(&child);

    // Poll the directory while the child runs. 150 ms is far cheaper than the
    // decode itself and makes the chunk counter move at the speed the files
    // actually appear.
    on_progress(0, expected);
    let mut last_done = 0usize;
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("waiting for ffmpeg: {e}"))?
        {
            Some(status) => break status,
            None => {
                let done = count_chunks(&chunk_dir);
                if done != last_done {
                    last_done = done;
                    on_progress(done, expected.max(done));
                }
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
    };

    if !status.success() {
        return Err(format!("ffmpeg audio extraction failed: {status}"));
    }

    // Collect produced chunks in filename order — from the **per-source**
    // directory; the root would show nothing with the subdir layout.
    let mut files: Vec<PathBuf> = fs::read_dir(&chunk_dir)
        .map_err(|e| format!("could not read chunk dir: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| is_chunk_wav(p))
        .collect();
    files.sort();

    if files.is_empty() {
        return Err("ffmpeg produced no audio chunks".to_string());
    }

    let mut chunks = Vec::with_capacity(files.len());
    let mut offset = 0.0;
    for (i, f) in files.iter().enumerate() {
        let dur = probe_duration(f).unwrap_or(segment_secs);
        chunks.push(AudioChunk {
            index: i,
            path: f.to_string_lossy().into_owned(),
            offset_secs: round3(offset),
            duration_secs: round3(dur),
        });
        offset += dur;
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
}
