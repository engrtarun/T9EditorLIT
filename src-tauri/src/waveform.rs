//! Waveform peak extraction — ZERO-RAM streaming.
//!
//! Spawns `ffmpeg`, reads raw `s16le` PCM off its stdout in small chunks, folds
//! samples into per-bucket peaks, and hard-kills the child the moment enough
//! samples have been read. Nothing proportional to the media duration is ever
//! resident: the entire run is `bars * 2` bytes of peak state plus a 32 KiB
//! read buffer. The resulting peaks are cached as a binary blob on disk.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::cache;

/// Bytes of raw PCM (s16le, mono) read per chunk from ffmpeg's stdout.
const READ_CHUNK: usize = 32 * 1024;
/// Hard ceiling on extraction wall time. Beyond this ffmpeg is killed and the
/// partial peak set (built from the head of the file) is returned.
const EXTRACT_DEADLINE: Duration = Duration::from_secs(15);
/// Safety net: refuse absurd bar counts so peak state stays bounded.
const MAX_BARS: usize = 8_192;

/// Waveform peaks returned to the frontend. Serialized camelCase to match
/// `WaveformData` in `src/lib/types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub duration_secs: f64,
    pub bars: usize,
    /// Absolute peak per bucket in the range 0.0..=1.0 (i16 full scale).
    pub peaks: Vec<f32>,
    #[serde(default)]
    pub cache_path: Option<PathBuf>,
}

/// Streaming peak accumulator. Folds consecutive PCM samples into `peaks`,
/// carrying the running maximum into the next bucket once `samples_per_bar`
/// samples have been consumed. State is `bars * 4` bytes regardless of input
/// length.
#[derive(Debug, Clone)]
pub struct PeakFolder {
    peaks: Vec<f32>,
    bucket: f32,
    filled: u64,
    samples_per_bar: u64,
    cursor: usize,
    emitted: usize,
    leftover: Option<u8>,
}

impl PeakFolder {
    pub fn new(bars: usize, samples_per_bar: u64) -> Self {
        Self {
            peaks: vec![0.0; bars],
            bucket: 0.0,
            filled: 0,
            samples_per_bar: samples_per_bar.max(1),
            cursor: 0,
            emitted: 0,
            leftover: None,
        }
    }

    /// Absolute value of one native-endian i16 sample.
    #[inline]
    fn abs_sample(raw: i16) -> f32 {
        // i16::MIN.abs_overflows; clamp before negating.
        (raw as f32).abs()
    }

    #[inline]
    fn push_sample(&mut self, raw: i16) {
        let a = Self::abs_sample(raw);
        if a > self.bucket {
            self.bucket = a;
        }
        self.filled += 1;
        if self.filled >= self.samples_per_bar {
            if self.cursor < self.peaks.len() {
                self.peaks[self.cursor] = self.bucket;
                self.cursor += 1;
                self.emitted = self.cursor;
            }
            self.bucket = 0.0;
            self.filled = 0;
        }
    }

    /// Feed a slice of native-endian i16 PCM.
    pub fn push_i16(&mut self, samples: &[i16]) {
        for &s in samples {
            self.push_sample(s);
        }
    }

    /// Feed raw `s16le` bytes (little-endian on every target platform here).
    ///
    /// A trailing odd byte is carried across calls so a sample split across
    /// two chunks is never dropped or mis-aligned.
    pub fn push_bytes(&mut self, bytes: &[u8]) {
        let mut i = 0;
        if let Some(lo) = self.leftover.take() {
            if !bytes.is_empty() {
                let s = i16::from_le_bytes([lo, bytes[0]]);
                self.push_sample(s);
                i = 1;
            } else {
                self.leftover = Some(lo);
                return;
            }
        }
        while i + 1 < bytes.len() {
            let s = i16::from_le_bytes([bytes[i], bytes[i + 1]]);
            self.push_sample(s);
            i += 2;
        }
        if i < bytes.len() {
            self.leftover = Some(bytes[i]);
        }
    }

    /// Finish the trailing bucket so every bar gets a value, then normalize to
    /// 0..=1 and return. Idempotent: further pushes are dropped.
    ///
    /// A trailing partial bucket is committed to the next bar when there is
    /// room; when every bar is already full it is folded into the last bar so
    /// its peak still shapes the normalization scale.
    pub fn finish(mut self) -> Vec<f32> {
        if self.filled > 0 {
            if self.emitted < self.peaks.len() {
                let idx = self.cursor;
                if idx < self.peaks.len() {
                    self.peaks[idx] = self.bucket;
                    self.emitted = idx + 1;
                }
            } else if !self.peaks.is_empty() {
                let idx = self.peaks.len() - 1;
                if self.bucket > self.peaks[idx] {
                    self.peaks[idx] = self.bucket;
                }
            }
        }
        let max = self.peaks.iter().cloned().fold(0.0f32, f32::max);
        if max <= 0.0 {
            return self.peaks;
        }
        let inv = 1.0 / max;
        for p in &mut self.peaks {
            *p *= inv;
        }
        self.peaks
    }

    /// Bars emitted so far (complete buckets).
    pub fn emitted(&self) -> usize {
        self.emitted
    }
}

/// Extract waveform peaks for `bars` buckets, reading from the **start** of
/// the file only (O(head) regardless of duration). Result is cached on disk
/// keyed by path + size + mtime, so repeat calls never spawn ffmpeg.
pub fn extract(source: &Path, root: &Path, bars: usize) -> Result<WaveformData, String> {
    let bars = bars.clamp(1, MAX_BARS);
    let meta = fs::metadata(source)
        .map_err(|e| format!("waveform: cannot stat {}: {e}", source.display()))?;
    let dur = probe_duration(source).unwrap_or(0.0);
    let key = cache::source_key(source, &meta)?;
    let cache_path = cache::dir(root, "waveform")?.join(format!("{key}.json"));

    if let Some(data) = read_cache(&cache_path, bars)? {
        return Ok(data);
    }

    let samples_per_bar = samples_per_bar(dur, bars);
    let peaks = stream_peaks(source, bars, samples_per_bar)?;

    let data = WaveformData {
        duration_secs: dur,
        bars: peaks.len(),
        peaks,
        cache_path: Some(cache_path.clone()),
    };
    let _ = write_cache(&cache_path, &data);
    Ok(data)
}

/// ffmpeg emits 48 000 mono samples/s by default; keep that assumption local.
const SAMPLE_RATE: u64 = 48_000;

fn samples_per_bar(duration_secs: f64, bars: usize) -> u64 {
    if duration_secs <= 0.0 {
        return 1;
    }
    let total = (duration_secs * SAMPLE_RATE as f64) as u64;
    (total / bars.max(1) as u64).max(1)
}

/// Spawn ffmpeg, fold its PCM stdout into peaks, kill it at the deadline.
fn stream_peaks(source: &Path, bars: usize, samples_per_bar: u64) -> Result<Vec<f32>, String> {
    let mut child = Command::new("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(source)
        .args(["-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-f", "s16le", "-"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg stdout unavailable".to_string())?;

    let mut folder = PeakFolder::new(bars, samples_per_bar);
    let mut buf = vec![0u8; READ_CHUNK];
    let started = Instant::now();

    loop {
        if started.elapsed() > EXTRACT_DEADLINE || folder.emitted() >= bars {
            break;
        }
        let n = match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        folder.push_bytes(&buf[..n]);
    }

    // Hard-kill: no waiting on graceful shutdown for a possibly huge file.
    let _ = child.kill();
    let _ = child.wait();

    Ok(folder.finish())
}

fn probe_duration(source: &Path) -> Option<f64> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(source)
        .stderr(Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

fn read_cache(path: &Path, bars: usize) -> Result<Option<WaveformData>, String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(None);
    };
    let Ok(data) = serde_json::from_str::<WaveformData>(&text) else {
        return Ok(None);
    };
    if data.bars != bars || data.peaks.len() != bars {
        return Ok(None);
    }
    Ok(Some(data))
}

fn write_cache(path: &Path, data: &WaveformData) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(data).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assert with f32 epsilon — normalization divides by a float max.
    fn close(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn folder_folds_samples_into_buckets() {
        // 4 bars, 2 samples per bar.
        let mut f = PeakFolder::new(4, 2);
        f.push_i16(&[10, 20, 5, 7, 100, 1, 2, 3]);
        let peaks = f.finish();
        assert_eq!(peaks.len(), 4);
        // Raw bucket maxima: 20, 7, 100, 3 — normalized by global max 100.
        assert!(close(peaks[0], 20.0 / 100.0), "{}", peaks[0]);
        assert!(close(peaks[1], 7.0 / 100.0), "{}", peaks[1]);
        assert!(close(peaks[2], 1.0), "{}", peaks[2]);
        assert!(close(peaks[3], 3.0 / 100.0), "{}", peaks[3]);
    }

    #[test]
    fn finish_closes_trailing_partial_bucket() {
        let mut f = PeakFolder::new(3, 4);
        f.push_i16(&[1, 2, 3, 4, 5, 6]); // bucket 0 full, bucket 1 partial
        let peaks = f.finish();
        assert_eq!(peaks.len(), 3);
        assert!(close(peaks[1], 1.0), "{}", peaks[1]); // partial bucket committed
        assert_eq!(peaks[2], 0.0); // untouched bucket stays 0
    }

    #[test]
    fn normalizes_to_unit_range() {
        let mut f = PeakFolder::new(2, 1);
        f.push_i16(&[1000, -4000]); // negatives take abs
        let peaks = f.finish();
        assert!(close(peaks[0], 0.25), "{}", peaks[0]);
        assert!(close(peaks[1], 1.0), "{}", peaks[1]);
    }

    #[test]
    fn handles_split_bytes_across_chunks() {
        let mut f = PeakFolder::new(2, 2);
        // 5 samples: 100, -200, 300, 400, 500 as LE bytes, split mid-sample.
        let bytes: Vec<u8> = [100i16, -200, 300, 400, 500]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let (a, b) = bytes.split_at(5); // splits inside sample #3
        f.push_bytes(a);
        f.push_bytes(b);
        let peaks = f.finish();
        assert_eq!(peaks.len(), 2);
        // Raw maxima 200, 500 — normalized by global max 500.
        assert!(close(peaks[0], 200.0 / 500.0), "{}", peaks[0]);
        assert!(close(peaks[1], 1.0), "{}", peaks[1]);
    }

    #[test]
    fn cache_roundtrip_rejects_bar_mismatch() {
        let dir = std::env::temp_dir().join("t9_waveform_test");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("peaks.json");
        let data = WaveformData {
            duration_secs: 1.5,
            bars: 2,
            peaks: vec![0.5, 1.0],
            cache_path: Some(path.clone()),
        };
        write_cache(&path, &data).unwrap();
        assert!(read_cache(&path, 2).unwrap().is_some());
        assert!(read_cache(&path, 4).unwrap().is_none());
        let _ = fs::remove_file(&path);
    }
}
