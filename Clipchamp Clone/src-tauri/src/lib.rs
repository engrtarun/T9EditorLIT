//! Tauri command surface — **declarations only**.
//!
//! Per AGENTS.md this file holds no business logic. Pure work lives in
//! `model.rs`, `timeline.rs` and `probe.rs`, which unit-test without a
//! webview. Signatures only exist here so `lib/ipc.ts` has a single typed
//! choke point to mirror.

mod model;
mod probe;
mod timeline;

use model::Asset;
use serde_json::Value;
use std::path::PathBuf;

/// Probe a media file for duration, dimensions, fps and codecs.
///
/// **Scaffold stub.** The argument construction in `probe.rs` is implemented and
/// unit-tested; spawning and reaping the short-lived `ffprobe` child is not.
/// Returning an error is deliberate — returning a zeroed `Asset` would hand the
/// UI plausible-looking metadata that is simply wrong.
///
/// When wired up: `probe::probe_args(&path)` builds the argv, spawn it, read
/// stdout, parse with `probe::asset_from_probe`, then kill and wait. Never read
/// the media file itself — see AGENTS.md.
#[tauri::command]
async fn probe_media(path: PathBuf) -> Result<Asset, String> {
    if !path.exists() {
        return Err(format!("no such file: {}", path.display()));
    }
    Err(format!(
        "probe_media is a scaffold stub: ffprobe child not wired up yet ({})",
        path.display()
    ))
}

/// Build (but do not run) the FFmpeg export command for a clip range.
///
/// Returning the argv lets the UI show exactly what would be executed.
#[tauri::command]
async fn build_export_command(
    input: PathBuf,
    output: PathBuf,
    settings: Value,
) -> Result<Vec<String>, String> {
    let s: model::ExportSettings =
        serde_json::from_value(settings).map_err(|e| format!("bad export settings: {e}"))?;
    Ok(probe::export_args(
        &input,
        &output,
        "",
        s.width,
        s.height,
        s.fps,
        s.video_kbps,
        s.audio_kbps,
        &s.codec,
        s.prefer_hardware,
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![probe_media, build_export_command])
        .run(tauri::generate_context!())
        .expect("error while running Clipchamp Clone");
}