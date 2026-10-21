//! Audio extraction and chunking (Chunk 2, step 2).
//!
//! FFmpeg pulls a mono 16 kHz PCM track out of the source and segments it into
//! ~15 MB (default 300 s) WAV chunks. The 5 GB video is never loaded into
//! this process's address space; only short-lived child processes touch it.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let out = Command::new("ffprobe")
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

/// Extract mono 16 kHz audio and split it into chunks of at most `segment_secs`
/// seconds. Returns the ordered list of chunk files with their offsets into the
/// original video.
pub fn extract_chunks(
    source: &Path,
    out_dir: &Path,
    segment_secs: f64,
) -> Result<Vec<AudioChunk>, String> {
    if !source.exists() {
        return Err(format!("source file not found: {}", source.display()));
    }
    let segment_secs = if segment_secs <= 0.0 {
        300.0
    } else {
        segment_secs
    };

    fs::create_dir_all(out_dir)
        .map_err(|e| format!("could not create chunk dir {}: {e}", out_dir.display()))?;

    // Clean stale chunks from a previous run so we never mix old and new.
    if let Ok(entries) = fs::read_dir(out_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("wav")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("chunk_"))
                    .unwrap_or(false)
            {
                let _ = fs::remove_file(p);
            }
        }
    }

    let pattern = out_dir.join("chunk_%03d.wav");
    let seg_arg = format!("{segment_secs}");
    let status = Command::new("ffmpeg")
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
        .status()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !status.success() {
        return Err(format!("ffmpeg audio extraction failed: {status}"));
    }

    // Collect produced chunks in filename order.
    let mut files: Vec<PathBuf> = fs::read_dir(out_dir)
        .map_err(|e| format!("could not read chunk dir: {e}"))?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()) == Some("wav")
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("chunk_"))
                    .unwrap_or(false)
        })
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
    let output = Command::new("ffmpeg")
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
