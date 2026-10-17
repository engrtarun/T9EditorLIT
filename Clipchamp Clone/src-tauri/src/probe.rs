//! FFprobe/FFmpeg argument construction.
//!
//! This module *builds* command lines and never runs them, which keeps it
//! pure and unit-testable. `ffmpeg.rs` owns spawning and killing children.
//!
//! ZERO-RAM: probing a 5 GB file must not read it. Every call here is a
//! short-lived `ffprobe` child over a file handle, killed the moment it exits.

// Same scaffold caveat as timeline.rs: tested, but no command calls it yet.
#![allow(dead_code)]

use crate::model::Asset;
use std::path::Path;

/// Build the ffprobe argument list for a JSON dump of all streams.
pub fn probe_args(path: &Path) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string_lossy().into_owned(),
    ]
}

/// Build the FFmpeg argument list for a single-clip export.
#[allow(clippy::too_many_arguments)]
pub fn export_args(
    input: &Path,
    output: &Path,
    filters: &str,
    width: u32,
    height: u32,
    fps: u32,
    video_kbps: u32,
    audio_kbps: u32,
    codec: &str,
    hardware: bool,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];

    if hardware {
        // Intel QuickSync: the i3 iGPU. Falls back to software when absent.
        args.push("-c:v".into());
        args.push("h264_qsv".into());
    } else {
        args.push("-c:v".into());
        args.push(match codec {
            "hevc" => "libx265",
            "vp9" => "libvpx-vp9",
            _ => "libx264",
        }
        .into());
    }

    args.push("-vf".into());
    args.push(if filters.is_empty() {
        "scale=-2:2".to_string() // even dimensions keep H.264 encoders happy
    } else {
        format!("scale={width}:{height},{filters}")
    });

    args.push("-b:v".into());
    args.push(format!("{video_kbps}k"));
    args.push("-c:a".into());
    args.push("aac".into());
    args.push("-b:a".into());
    args.push(format!("{audio_kbps}k"));
    args.push("-r".into());
    args.push(fps.to_string());
    args.push(input.to_string_lossy().into_owned());
    args.push(output.to_string_lossy().into_owned());
    args
}

/// Pick a display name from a path without touching the filesystem.
pub fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Derive an `Asset` from an ffprobe JSON payload.
///
/// Kept separate from process spawning so the parsing rules can be tested
/// against fixtures without spawning anything.
pub fn asset_from_probe(id: String, path: &Path, json: &serde_json::Value) -> Asset {
    let format = json.get("format");
    let streams = json
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("video"));
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));

    let duration_secs = format
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let size_bytes = format
        .and_then(|f| f.get("size"))
        .and_then(|s| s.as_str())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let width = video
        .and_then(|s| s.get("width"))
        .and_then(|w| w.as_u64())
        .map(|w| w as u32);
    let height = video
        .and_then(|s| s.get("height"))
        .and_then(|h| h.as_u64())
        .map(|h| h as u32);

    let kind = match (video.is_some(), audio.is_some()) {
        (_, true) if video.is_none() => crate::model::AssetKind::Audio,
        (true, _) => crate::model::AssetKind::Video,
        _ => crate::model::AssetKind::Image,
    };

    Asset {
        id,
        path: path.to_string_lossy().into_owned(),
        kind,
        duration_secs,
        size_bytes,
        width,
        height,
        fps: video
            .and_then(|s| s.get("avg_frame_rate"))
            .and_then(|r| r.as_str())
            .and_then(parse_ratio),
        has_audio: audio.is_some(),
        thumbnail_path: None,
    }
}

/// Resolve ffprobe's `"num/den"` frame rate to a float.
pub fn parse_ratio(ratio: &str) -> Option<f64> {
    let (num, den) = ratio.split_once('/')?;
    let n: f64 = num.parse().ok()?;
    let d: f64 = den.parse().ok()?;
    if d == 0.0 {
        return None;
    }
    Some(n / d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_args_request_json_and_end_with_the_path() {
        let args = probe_args(Path::new("C:/media/a.mp4"));
        assert_eq!(args[0], "-v");
        assert!(args.contains(&"json".to_string()));
        assert_eq!(args.last().unwrap(), "C:/media/a.mp4");
    }

    #[test]
    fn export_args_prefer_qsv_when_hardware_is_requested() {
        let args = export_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            "eq=saturation=1.500",
            1920,
            1080,
            30,
            8000,
            192,
            "h264",
            true,
        );
        assert!(args.windows(2).any(|w| w == ["-c:v", "h264_qsv"]));
        assert!(args.iter().any(|a| a.contains("eq=saturation")));
    }

    #[test]
    fn export_args_fall_back_to_software_and_scale_even_when_no_filters() {
        let args = export_args(
            Path::new("in.mp4"),
            Path::new("out.mp4"),
            "",
            1920,
            1080,
            30,
            8000,
            192,
            "hevc",
            false,
        );
        assert!(args.windows(2).any(|w| w == ["-c:v", "libx265"]));
        assert!(args.iter().any(|a| a.contains("scale=-2:2")));
    }

    #[test]
    fn parse_ratio_handles_59_94_and_bad_input() {
        assert_eq!(parse_ratio("30000/1001").unwrap(), 29.970_029_970_029_97);
        assert_eq!(parse_ratio("30/1").unwrap(), 30.0);
        assert!(parse_ratio("0/0").is_none());
        assert!(parse_ratio("garbage").is_none());
    }

    #[test]
    fn display_name_uses_the_final_path_segment() {
        assert_eq!(display_name(Path::new("C:/a/b/clip.mp4")), "clip.mp4");
    }

    #[test]
    fn asset_from_probe_reads_video_streams() {
        let json = serde_json::json!({
            "format": { "duration": "12.5", "size": "2048" },
            "streams": [
                { "codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30/1" },
                { "codec_type": "audio", "sample_rate": "48000" }
            ]
        });
        let a = asset_from_probe("a1".into(), Path::new("clip.mp4"), &json);
        assert_eq!(a.duration_secs, 12.5);
        assert_eq!(a.size_bytes, 2048);
        assert_eq!(a.width, Some(1920));
        assert_eq!(a.fps, Some(30.0));
        assert!(a.has_audio);
    }

    #[test]
    fn asset_from_probe_flags_audio_only_files() {
        let json = serde_json::json!({
            "format": { "duration": "90.0", "size": "4096" },
            "streams": [{ "codec_type": "audio" }]
        });
        let a = asset_from_probe("a1".into(), Path::new("song.mp3"), &json);
        assert_eq!(a.kind, crate::model::AssetKind::Audio);
        assert_eq!(a.width, None);
        assert!(a.has_audio);
    }

    #[test]
    fn asset_from_probe_survives_malformed_json() {
        let a = asset_from_probe("a1".into(), Path::new("x.bin"), &serde_json::json!({}));
        assert_eq!(a.duration_secs, 0.0);
        assert_eq!(a.size_bytes, 0);
        assert_eq!(a.kind, crate::model::AssetKind::Image);
    }
}