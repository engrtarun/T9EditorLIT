//! Thumbnail strip extraction (Chunk 3).
//!
//! Samples one frame per second (configurable) at a small width and writes
//! lightweight JPEGs into a per-source cache directory. The strip is served to
//! the webview straight from disk through the asset protocol, so no decoded
//! frame ever enters this process's heap.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;

use super::{cache, media};

const DEFAULT_FPS: f64 = 1.0;
const DEFAULT_WIDTH: u32 = 160;
const MIN_FPS: f64 = 0.1;
const MAX_FPS: f64 = 4.0;
const MIN_WIDTH: u32 = 64;
const MAX_WIDTH: u32 = 640;
/// mjpeg quality: 2 (best) .. 31 (worst). 5 keeps files ~5–8 KB at 160 px.
const JPEG_QUALITY: &str = "5";
const MANIFEST: &str = "manifest.json";

/// What the frontend needs to render the strip: where the frames are and how
/// many there are. Individual paths are derived (`thumb_00001.jpg`, …) so the
/// IPC payload stays a few dozen bytes instead of thousands of strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailStrip {
    pub duration_secs: f64,
    pub fps: f64,
    pub count: usize,
    pub width: u32,
    pub height: u32,
    pub dir: String,
}

/// On-disk record of a completed extraction, so a reload can skip FFmpeg.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThumbManifest {
    fps: f64,
    width: u32,
    height: u32,
    count: usize,
    duration_secs: f64,
}

/// Cache-aware entry point: reuse `<root>/thumbs/<key>/` when its manifest
/// matches the requested sampling, otherwise extract, write, and return.
pub fn extract(
    source: &Path,
    root: &Path,
    fps: Option<f64>,
    width: Option<u32>,
) -> Result<ThumbnailStrip, String> {
    if !source.exists() {
        return Err(format!("source file not found: {}", source.display()));
    }
    let fps = fps.unwrap_or(DEFAULT_FPS).clamp(MIN_FPS, MAX_FPS);
    let width = width.unwrap_or(DEFAULT_WIDTH).clamp(MIN_WIDTH, MAX_WIDTH);

    // Also validates that the source actually has a video stream to sample.
    let info = media::MediaInfo::probe(source)?;
    let duration = info.duration_secs;
    if duration <= 0.0 {
        return Err("source has no measurable duration".to_string());
    }

    let meta = std::fs::metadata(source).map_err(|e| e.to_string())?;
    let key = cache::source_key(source, &meta)?;
    let dir = cache::thumbs_dir(root, &key);
    let manifest_path = dir.join(MANIFEST);

    if let Ok(text) = fs::read_to_string(&manifest_path)
        && let Ok(m) = serde_json::from_str::<ThumbManifest>(&text)
        && (m.fps - fps).abs() < f64::EPSILON
        && m.width == width
        && m.count > 0
    {
        return Ok(ThumbnailStrip {
            duration_secs: round3(duration),
            fps,
            count: m.count,
            width,
            height: m.height,
            dir: dir.to_string_lossy().into_owned(),
        });
    }

    fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create thumbnail dir {}: {e}", dir.display()))?;
    clean_stale_frames(&dir);

    let pattern = dir.join("thumb_%05d.jpg");
    let vf = format!("fps={fps},scale={width}:-2");
    let status = Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"])
        // Frame-threaded decode is where FFmpeg's RAM lives: every thread owns
        // its own decoder context plus one or two reference frames, and on a
        // 4K source each of those frames is megabytes. Letting it default to
        // one thread per logical CPU is the difference between "tens of MB" and
        // "a spike you can watch climb in the RAM meter" on an 8 GB box — and
        // two i3 threads still finish a 1 fps strip long before the user scrolls
        // to it. Placed before `-i` so it binds the DECODER, not the muxer.
        .args(["-threads", "2", "-i"])
        .arg(source)
        .args(["-vf", &vf, "-q:v", JPEG_QUALITY, "-f", "image2"])
        .arg(&pattern)
        .status()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !status.success() {
        return Err(format!("ffmpeg thumbnail extraction failed: {status}"));
    }

    let count = count_frames(&dir)?;
    if count == 0 {
        return Err("ffmpeg produced no thumbnails".to_string());
    }

    let height = scaled_height(info.width, info.height, width);
    let manifest = ThumbManifest {
        fps,
        width,
        height,
        count,
        duration_secs: round3(duration),
    };
    let json = serde_json::to_string(&manifest)
        .map_err(|e| format!("could not serialize manifest: {e}"))?;
    fs::write(&manifest_path, json)
        .map_err(|e| format!("could not write thumbnail manifest: {e}"))?;

    Ok(ThumbnailStrip {
        duration_secs: round3(duration),
        fps,
        count,
        width,
        height,
        dir: dir.to_string_lossy().into_owned(),
    })
}

/// Picture formats the app is willing to show as a poster.
const IMAGE_EXTENSIONS: [&str; 6] = ["jpg", "jpeg", "png", "webp", "bmp", "gif"];

/// Copy a hand-picked picture into the app's cache and return where it landed.
///
/// The picture is **never read into memory**: `fs::copy` hands the job to the
/// OS, byte for byte, and this process only ever holds the path. The file is
/// named after the source it belongs to, so uploading a new poster replaces
/// the old one instead of piling up copies — and a library that pointed at
/// the user's own Desktop would break the moment they moved the file.
pub fn import_custom(source: &str, image: &Path, root: &Path) -> Result<String, String> {
    if !image.is_file() {
        return Err(format!("picture not found: {}", image.display()));
    }
    let ext = image
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("that is not a picture the app can show: .{ext}"));
    }

    let dir = root.join("thumbs").join("custom");
    fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    // One file per source: re-uploading replaces the poster in place.
    let key = cache::hash_hex(&[source.as_bytes()]);
    let dest = dir.join(format!("{key}.{ext}"));
    fs::copy(image, &dest)
        .map_err(|e| format!("could not copy {} to {}: {e}", image.display(), dest.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Height after `scale=<width>:-2`: proportional, then rounded down to even
/// (the `-2` in the filter guarantees an even height for mjpeg).
fn scaled_height(src_w: Option<u32>, src_h: Option<u32>, width: u32) -> u32 {
    match (src_w, src_h) {
        (Some(w), Some(h)) if w > 0 => {
            let h = (h as f64 * width as f64 / w as f64).round() as u32;
            ((h / 2) * 2).max(2)
        }
        _ => width / 2 * 2,
    }
}

fn clean_stale_frames(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("jpg") {
                let _ = fs::remove_file(p);
            }
        }
    }
}

fn count_frames(dir: &Path) -> Result<usize, String> {
    Ok(fs::read_dir(dir)
        .map_err(|e| format!("could not read thumbnail dir: {e}"))?
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jpg"))
        .count())
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaled_height_stays_proportional_and_even() {
        // 1920x1080 at width 160 -> 90, already even.
        assert_eq!(scaled_height(Some(1920), Some(1080), 160), 90);
        // 1920x1080 at width 161 -> 90.56 -> 91 -> round down to 90.
        assert_eq!(scaled_height(Some(1920), Some(1080), 161), 90);
        // Unknown dimensions fall back to a sane even value.
        assert_eq!(scaled_height(None, None, 160), 160);
    }
}
