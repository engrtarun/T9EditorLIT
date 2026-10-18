//! Media inspection (Chunk 2, step 1).
//!
//! Answers, in a fraction of a second and with no memory cost: how long is this
//! file, how big is it, what resolution, what frame rate, and is there audio to
//! transcribe?

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    pub index: i64,
    pub codec_type: String,
    pub codec_name: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub avg_frame_rate: Option<String>,
    pub pix_fmt: Option<String>,
    pub channels: Option<i64>,
    pub sample_rate: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub duration_secs: f64,
    pub size_bytes: u64,
    pub fps: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub pix_fmt: Option<String>,
    pub has_audio: bool,
    pub streams: Vec<StreamInfo>,
}

#[derive(Debug, Deserialize)]
struct RawProbe {
    #[serde(default)]
    format: Option<RawFormat>,
    #[serde(default)]
    streams: Vec<RawStream>,
}

#[derive(Debug, Deserialize)]
struct RawFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    index: i64,
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    #[serde(rename = "avg_frame_rate")]
    avg_frame_rate: Option<String>,
    pix_fmt: Option<String>,
    channels: Option<i64>,
    sample_rate: Option<String>,
}

/// SQLite cache for ffprobe results, keyed by source path + size + mtime so a
/// re-import of an unchanged file never spawns ffprobe again.
const MEDIA_CACHE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS media_cache (
    source_path TEXT PRIMARY KEY,
    size_bytes  INTEGER NOT NULL,
    mtime_secs  INTEGER NOT NULL,
    json        TEXT NOT NULL
);
";

pub fn init_media_cache_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(MEDIA_CACHE_SCHEMA)
        .map_err(|e| format!("could not init media cache schema: {e}"))
}

fn media_fingerprint(path: &Path) -> Result<(u64, i64), String> {
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("could not stat {}: {e}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok((meta.len(), mtime))
}

/// Cached probe result, or `None` when absent or stale (file replaced/resized).
pub fn load_cached_media(conn: &Connection, source_path: &str, path: &Path) -> Option<MediaInfo> {
    let (size, mtime) = media_fingerprint(path).ok()?;
    let mut stmt = conn
        .prepare(
            "SELECT json FROM media_cache WHERE source_path = ?1 AND size_bytes = ?2 AND mtime_secs = ?3",
        )
        .ok()?;
    let json: String = stmt
        .query_row(params![source_path, size as i64, mtime], |r| r.get(0))
        .ok()?;
    serde_json::from_str(&json).ok()
}

/// Persist a freshly probed result for next time.
pub fn store_cached_media(conn: &Connection, source_path: &str, path: &Path, info: &MediaInfo) -> Result<(), String> {
    let (size, mtime) = media_fingerprint(path)?;
    let json = serde_json::to_string(info).map_err(|e| format!("could not serialize media info: {e}"))?;
    conn.execute(
        "INSERT INTO media_cache (source_path, size_bytes, mtime_secs, json)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source_path) DO UPDATE SET
            size_bytes = excluded.size_bytes,
            mtime_secs = excluded.mtime_secs,
            json       = excluded.json",
        params![source_path, size as i64, mtime, json],
    )
    .map_err(|e| format!("could not cache media info: {e}"))?;
    Ok(())
}

/// Parse an ffprobe `"rate"` string such as `60000/1001` into a float.
fn parse_rate(rate: &str) -> Option<f64> {
    let mut parts = rate.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    match parts.next() {
        Some(den) => {
            let den: f64 = den.parse().ok()?;
            if den == 0.0 { None } else { Some(num / den) }
        }
        None => Some(num),
    }
}

impl MediaInfo {
    pub fn probe(path: &Path) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("file not found: {}", path.display()));
        }

        let json = super::ffmpeg::ffprobe_json(path)?;
        let raw: RawProbe = serde_json::from_str(&json)
            .map_err(|e| format!("could not parse ffprobe output: {e}"))?;

        let video = raw
            .streams
            .iter()
            .find(|s| s.codec_type == "video")
            .ok_or_else(|| "no video stream found in this file".to_string())?;
        let audio = raw.streams.iter().find(|s| s.codec_type == "audio");

        let duration_secs = raw
            .format
            .as_ref()
            .and_then(|f| f.duration.as_ref())
            .and_then(|d| d.parse::<f64>().ok())
            .unwrap_or(0.0);
        let size_bytes = raw
            .format
            .as_ref()
            .and_then(|f| f.size.as_ref())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or_else(|| std::fs::metadata(path).map(|m| m.len()).unwrap_or(0));

        let streams: Vec<StreamInfo> = raw
            .streams
            .iter()
            .map(|s| StreamInfo {
                index: s.index,
                codec_type: s.codec_type.clone(),
                codec_name: s.codec_name.clone(),
                width: s.width,
                height: s.height,
                avg_frame_rate: s.avg_frame_rate.clone(),
                pix_fmt: s.pix_fmt.clone(),
                channels: s.channels,
                sample_rate: s.sample_rate.clone(),
            })
            .collect();

        let fps = video
            .avg_frame_rate
            .as_ref()
            .and_then(|r| parse_rate(r))
            .filter(|f| *f > 0.0 && f.is_finite());

        Ok(Self {
            path: path.to_string_lossy().into_owned(),
            duration_secs,
            size_bytes,
            fps,
            width: video.width,
            height: video.height,
            video_codec: video.codec_name.clone(),
            audio_codec: audio.and_then(|a| a.codec_name.clone()),
            pix_fmt: video.pix_fmt.clone(),
            has_audio: audio.is_some(),
            streams,
        })
    }

    /// Probe with an on-disk cache: a cache hit returns the ffprobe facts
    /// without spawning a child process, so re-importing an unchanged 5 GB file
    /// is instant. A miss probes and stores the result for next time.
    pub fn probe_cached(path: &Path, conn: &Connection) -> Result<Self, String> {
        if !path.exists() {
            return Err(format!("file not found: {}", path.display()));
        }
        let key = path.to_string_lossy().into_owned();
        if let Some(cached) = load_cached_media(conn, &key, path) {
            return Ok(cached);
        }
        let info = Self::probe(path)?;
        let _ = store_cached_media(conn, &key, path, &info);
        Ok(info)
    }

    /// Human-readable resolution label, e.g. `3840x2160 (4K)`.
    pub fn resolution_label(&self) -> String {
        match (self.width, self.height) {
            (Some(w), Some(h)) => {
                let tier = match h {
                    2160 => "4K",
                    1440 => "1440p",
                    1080 => "1080p",
                    720 => "720p",
                    _ => "",
                };
                if tier.is_empty() {
                    format!("{w}x{h}")
                } else {
                    format!("{w}x{h} ({tier})")
                }
            }
            _ => "unknown".to_string(),
        }
    }

    /// `HH:MM:SS.mmm`, used everywhere in the transcript panel.
    pub fn duration_label(&self) -> String {
        format_timestamp(self.duration_secs)
    }
}

/// Format seconds as `HH:MM:SS.mmm` (or `MM:SS.mmm` under an hour).
pub fn format_timestamp(secs: f64) -> String {
    let secs = secs.max(0.0);
    let h = (secs / 3600.0).floor() as u64;
    let m = ((secs % 3600.0) / 60.0).floor() as u64;
    let s = (secs % 60.0).floor() as u64;
    let ms = ((secs - secs.floor()) * 1000.0).round() as u64;

    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}.{ms:03}")
    } else {
        format!("{m:02}:{s:02}.{ms:03}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fractional_rates() {
        assert_eq!(parse_rate("30/1"), Some(30.0));
        assert_eq!(parse_rate("60/1"), Some(60.0));
        let ntsc = parse_rate("60000/1001").unwrap();
        assert!((ntsc - 59.94).abs() < 0.01, "got {ntsc}");
    }

    #[test]
    fn rejects_zero_denominator() {
        assert_eq!(parse_rate("0/0"), None);
    }

    #[test]
    fn formats_short_and_long_durations() {
        assert_eq!(format_timestamp(75.25), "01:15.250");
        assert_eq!(format_timestamp(3725.5), "01:02:05.500");
    }

    #[test]
    fn formats_within_an_hour_without_hours() {
        assert_eq!(format_timestamp(9.5), "00:09.500");
    }
}
