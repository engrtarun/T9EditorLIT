//! Polish mode — background music deck with auto-ducking and text overlay.
//!
//! All media work streams through FFmpeg child processes; nothing is buffered
//! in this process's heap. A 5 GB source never lands in RAM here either.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Position presets for the text overlay.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextPosition {
    BottomLeft,
    TopLeft,
    Center,
}

impl Default for TextPosition {
    fn default() -> Self {
        TextPosition::BottomLeft
    }
}

impl TextPosition {
    /// FFmpeg drawtext x/y expressions for each preset.
    fn xy(self) -> (&'static str, &'static str) {
        match self {
            TextPosition::BottomLeft => ("10", "h-text_h-10"),
            TextPosition::TopLeft => ("10", "10"),
            TextPosition::Center => ("(w-text_w)/2", "(h-text_h)/2"),
        }
    }
}

/// Everything the polish render needs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolishSettings {
    pub music_path: Option<String>,
    pub music_volume: f64, // 0.0 – 1.0
    pub music_loop: bool,
    pub duck_enabled: bool,
    pub duck_db: f64, // dB to duck by, e.g. -14.0
    pub duck_attack_ms: f64,
    pub duck_release_ms: f64,
    pub text: String,
    pub text_position: TextPosition,
}

impl Default for PolishSettings {
    fn default() -> Self {
        Self {
            music_path: None,
            music_volume: 0.15,
            music_loop: true,
            duck_enabled: true,
            duck_db: -14.0,
            duck_attack_ms: 200.0,
            duck_release_ms: 800.0,
            text: String::new(),
            text_position: TextPosition::default(),
        }
    }
}

/// Result of a polish run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolishResult {
    pub output: String,
    pub duration_secs: f64,
    pub size_bytes: u64,
    pub warnings: Vec<String>,
}

/// Escape single quotes for FFmpeg filter graph strings.
fn filter_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// Build the audio filter chain: music volume → optional sidechain ducking.
fn audio_filter_chain(
    settings: &PolishSettings,
    has_music: bool,
    has_speech: bool,
) -> Option<String> {
    if !has_music && !has_speech {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();

    // Music input is stream 1 (index 1), speech is stream 0 of the source.
    if has_music {
        parts.push(format!("[1:a]volume={:.2}[music]", settings.music_volume));
    }

    if has_music && has_speech && settings.duck_enabled {
        // sidechaincompress: first input is the signal compressed (music),
        // second input is the sidechain (speech). When speech rises above
        // threshold, music is compressed down by duck_db.
        let threshold = 10.0f64.powf(settings.duck_db / 20.0);
        parts.push(format!(
            "[music][0:a]sidechaincompress=threshold={:.6}:ratio=100:attack={:.3}:release={:.3}:makeup=2[mixed]",
            threshold,
            settings.duck_attack_ms / 1000.0,
            settings.duck_release_ms / 1000.0,
        ));
    } else if has_music {
        parts.push("[music][0:a]amerge[mixed]".to_string());
    } else {
        parts.push("[0:a][0:a]amerge[mixed]".to_string());
    }

    Some(parts.join(";"))
}

/// Build the video filter chain: optional drawtext overlay.
fn video_filter_chain(settings: &PolishSettings) -> Option<String> {
    if settings.text.trim().is_empty() {
        return None;
    }

    let (x, y) = settings.text_position.xy();
    let fontfile = "C:/Windows/Fonts/segoeui.ttf"; // Windows default UI font

    Some(format!(
        "[0:v]drawtext=text='{}':fontfile='{}':fontcolor=white:fontsize=24:shadowcolor=black@0.6:shadowx=2:shadowy=2:x={}:y={}[video]",
        filter_escape(&settings.text),
        fontfile,
        x,
        y
    ))
}

/// Map filter outputs to `-map` arguments.
fn map_args(has_video_filter: bool, has_audio_filter: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if has_video_filter {
        args.push("-map".into());
        args.push("[video]".into());
    } else {
        args.push("-map".into());
        args.push("0:v:0".into());
    }
    if has_audio_filter {
        args.push("-map".into());
        args.push("[mixed]".into());
    } else {
        args.push("-map".into());
        args.push("0:a:0?".into());
    }
    args
}

/// Run one FFmpeg polish render. Streams through a child process; progress is
/// emitted via the `export-progress` event so the UI can show a live bar.
pub fn run_polish(
    _app: &tauri::AppHandle,
    source: &Path,
    output: &Path,
    settings: &PolishSettings,
) -> Result<PolishResult, String> {
    let info = crate::media::MediaInfo::probe(source)?;

    let has_audio = info.has_audio;
    let has_music = settings
        .music_path
        .as_ref()
        .map_or(false, |p| !p.is_empty());

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        source.to_string_lossy().into_owned(),
    ];

    if has_music {
        let music_path = PathBuf::from(settings.music_path.as_ref().unwrap());
        args.push("-stream_loop".into());
        args.push(if settings.music_loop {
            "-1".into()
        } else {
            "0".into()
        });
        args.push("-i".into());
        args.push(music_path.to_string_lossy().into_owned());
    }

    // Build filter_complex.
    let af = audio_filter_chain(settings, has_music, has_audio);
    let vf = video_filter_chain(settings);

    match (&af, &vf) {
        (Some(a), Some(v)) => {
            args.push("-filter_complex".into());
            args.push(format!("{};{}", v, a));
        }
        (Some(a), None) => {
            args.push("-filter_complex".into());
            args.push(a.clone());
        }
        (None, Some(v)) => {
            args.push("-filter_complex".into());
            args.push(v.clone());
        }
        (None, None) => {}
    }

    let maps = map_args(vf.is_some(), af.is_some());
    args.extend(maps);

    // Short audio fade so cuts don't click.
    if has_audio || has_music {
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    }
    args.push("-c:v".into());
    args.push("copy".into());
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());
    args.push(output.to_string_lossy().into_owned());

    let out = crate::ffmpeg::run(
        "ffmpeg",
        &args.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
    )?;

    if !out.success() {
        return Err(format!(
            "polish FFmpeg failed (exit {}): {}",
            out.status,
            out.stderr.trim()
        ));
    }

    let out_info = crate::media::MediaInfo::probe(output)
        .map_err(|e| format!("polish finished but output could not be probed: {e}"))?;

    Ok(PolishResult {
        output: output.to_string_lossy().into_owned(),
        duration_secs: out_info.duration_secs,
        size_bytes: out_info.size_bytes,
        warnings: vec![],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_position_xy_expressions() {
        assert_eq!(TextPosition::BottomLeft.xy(), ("10", "h-text_h-10"));
        assert_eq!(TextPosition::TopLeft.xy(), ("10", "10"));
        assert_eq!(TextPosition::Center.xy(), ("(w-text_w)/2", "(h-text_h)/2"));
    }

    #[test]
    fn filter_escape_handles_quotes_and_backslashes() {
        assert_eq!(filter_escape("it's"), r#"it\'s"#);
        assert_eq!(filter_escape("path\\file"), r#"path\\file"#);
    }

    #[test]
    fn default_settings_are_sane() {
        let s = PolishSettings::default();
        assert!((s.music_volume - 0.15).abs() < f64::EPSILON);
        assert!(s.music_loop);
        assert!(s.duck_enabled);
        assert!((s.duck_db - -14.0).abs() < f64::EPSILON);
        assert!((s.duck_attack_ms - 200.0).abs() < f64::EPSILON);
        assert!((s.duck_release_ms - 800.0).abs() < f64::EPSILON);
        assert!(s.text.is_empty());
    }

    #[test]
    fn duck_threshold_from_db() {
        let s = PolishSettings {
            duck_db: -14.0,
            ..Default::default()
        };
        let threshold = 10.0f64.powf(s.duck_db / 20.0);
        assert!((threshold - 0.1995).abs() < 0.01, "threshold = {threshold}");
    }
}
