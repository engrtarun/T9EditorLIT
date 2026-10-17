//! T9EditorLIT — Rust core.
//!
//! Design rule for this crate: **nothing large ever lives in this process's
//! heap**. Media is inspected and manipulated through short-lived child
//! processes, and bulky state belongs in SQLite on disk. Rust is here because it
//! actually returns freed memory to Windows instead of sitting on a GC heap.

mod ffmpeg;
mod media;
mod memory;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

pub use ffmpeg::HardwareSupport;
pub use media::{MediaInfo, StreamInfo};
pub use memory::MemoryStats;

type Probe = Mutex<memory::MemoryProbe>;

/// Live memory reading for the top-bar RAM meter.
#[tauri::command]
fn get_memory_stats(probe: State<'_, Probe>) -> Result<MemoryStats, String> {
    probe
        .lock()
        .map(|mut p| p.sample())
        .map_err(|_| "memory probe lock was poisoned".to_string())
}

/// Inspect a media file: duration, size, resolution, fps, codecs.
///
/// Returns in milliseconds — it shells out to `ffprobe` and reads nothing from
/// the file itself.
#[tauri::command]
fn probe_media(path: String) -> Result<MediaInfo, String> {
    let path = PathBuf::from(path);
    MediaInfo::probe(&path)
}

/// Which hardware encoders this machine can actually use (QuickSync on Intel
/// iGPUs, NVENC on NVIDIA, AMF on AMD). Determines the Chunk 4 export path.
#[tauri::command]
fn detect_hardware() -> Result<HardwareSupport, String> {
    Ok(HardwareSupport::detect())
}

/// Cheap liveness check so the UI can show a clear "FFmpeg not found" message
/// instead of failing mysteriously at export time.
#[tauri::command]
fn check_ffmpeg() -> Result<String, String> {
    let out = ffmpeg::run("ffmpeg", &["-version"])?;
    if !out.success() {
        return Err("ffmpeg is present but returned an error".to_string());
    }
    out.stdout
        .lines()
        .next()
        .map(str::to_string)
        .ok_or_else(|| "could not read ffmpeg version".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(memory::MemoryProbe::new()))
        .invoke_handler(tauri::generate_handler![
            get_memory_stats,
            probe_media,
            detect_hardware,
            check_ffmpeg
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("T9EditorLIT — dev")?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
