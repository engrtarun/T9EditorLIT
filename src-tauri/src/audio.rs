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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round3_trims_noise() {
        assert_eq!(round3(1.234567), 1.235);
        assert_eq!(round3(0.0), 0.0);
    }
}
