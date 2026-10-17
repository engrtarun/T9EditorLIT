//! Domain model, mirroring `src/lib/types.ts` exactly.
//!
//! Every struct that crosses IPC uses `rename_all = "camelCase"` so the
//! TypeScript side matches field-for-field. A mismatch here fails silently
//! as `undefined` in the UI, which is the bug class that wastes a day on a
//! long render.

// Same scaffold caveat as timeline.rs / probe.rs: this model is the intended
// command-facing shape and is covered by tests, but the commands do not
// construct all of it yet.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Video,
    Audio,
    Image,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    /// Absolute path on disk. Media is never loaded into memory.
    pub path: String,
    pub kind: AssetKind,
    pub duration_secs: f64,
    pub size_bytes: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    /// Preview tile on disk, never an embedded bitmap.
    pub thumbnail_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    Video,
    Overlay,
    Audio,
    Caption,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub name: String,
    pub height_px: u32,
    pub locked: bool,
    pub muted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransitionKind {
    Crossfade,
    Dissolve,
    DipToBlack,
    Wipe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub asset_id: String,
    pub track_id: String,
    pub start_secs: f64,
    pub duration_secs: f64,
    pub in_point_secs: f64,
    pub out_point_secs: f64,
    pub speed: f64,
    pub volume: f64,
    pub muted: bool,
    pub transition: Option<TransitionKind>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookAdjustments {
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub temperature: f64,
    pub tint: f64,
    pub vignette: f64,
}

impl LookAdjustments {
    /// The identity look: emitting nothing at all is the common case.
    pub fn neutral() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            temperature: 0.0,
            tint: 0.0,
            vignette: 0.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
    pub codec: String,
    pub container: String,
    pub prefer_hardware: bool,
}

impl Default for ExportSettings {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            fps: 30,
            video_kbps: 8000,
            audio_kbps: 192,
            codec: "h264".into(),
            container: "mp4".into(),
            prefer_hardware: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guards the contract AGENTS.md calls out: a field-name drift here shows
    /// up in the UI as `undefined` rather than a compile error.
    #[test]
    fn clip_serialises_to_camel_case() {
        let clip = Clip {
            id: "c1".into(),
            asset_id: "a1".into(),
            track_id: "t1".into(),
            start_secs: 0.0,
            duration_secs: 1.0,
            in_point_secs: 0.0,
            out_point_secs: 1.0,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            transition: None,
        };
        let json = serde_json::to_string(&clip).unwrap();
        assert!(json.contains("\"assetId\""), "{json}");
        assert!(json.contains("\"inPointSecs\""), "{json}");
        assert!(json.contains("\"startSecs\""), "{json}");
    }

    #[test]
    fn export_settings_default_to_1080p30_h264() {
        let s = ExportSettings::default();
        assert_eq!((s.width, s.height, s.fps), (1920, 1080, 30));
        assert_eq!(s.codec, "h264");
        assert!(s.prefer_hardware);
    }

    #[test]
    fn neutral_look_is_all_zero() {
        let l = LookAdjustments::neutral();
        assert_eq!(l, LookAdjustments::neutral());
        assert_eq!(l.vignette, 0.0);
    }
}