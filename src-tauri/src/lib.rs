//! T9EditorLIT — Rust core.
//!
//! Design rule for this crate: **nothing large ever lives in this process's
//! heap**. Media is inspected and manipulated through short-lived child
//! processes, and bulky state belongs in SQLite on disk. Rust is here because it
//! actually returns freed memory to Windows instead of sitting on a GC heap.

mod audio;
mod cache;
mod env;
mod export;
mod ffmpeg;
mod keyframes;
mod media;
mod memory;
mod polish;
mod thumbnail;
mod transcript;
mod waveform;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

type ExportCancel = Mutex<Option<Arc<AtomicBool>>>;

pub use env::{EnvEntry, EnvInfo};
pub use export::{ExportOptions, ExportPlan, ExportProgress, ExportRequest, ExportResult, Piece, Segment};

pub use audio::AudioChunk;
pub use ffmpeg::HardwareSupport;
pub use media::{MediaInfo, StreamInfo};
pub use memory::MemoryStats;
pub use thumbnail::ThumbnailStrip;
pub use polish::{PolishResult, PolishSettings};
pub use transcript::{TranscriptLine, Project};
pub use waveform::WaveformData;

type Probe = Mutex<memory::MemoryProbe>;

/// `<app_data>/cache` — home for waveform JSON and thumbnail frames.
fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("cache"))
}

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
/// Results are cached in SQLite keyed by path + size + mtime, so re-importing
/// an unchanged file skips ffprobe entirely (instant on a 5 GB source).
#[tauri::command]
fn probe_media(app: tauri::AppHandle, path: String) -> Result<MediaInfo, String> {
    let path = PathBuf::from(path);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = dir.join("t9editorlit.db");
    let conn = transcript::open_db(&db_path)?;
    media::init_media_cache_schema(&conn)?;
    MediaInfo::probe_cached(&path, &conn)
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

/// Extract mono 16 kHz audio from a source video into ~segment_secs WAV chunks.
#[tauri::command]
fn extract_audio_chunks(
    path: String,
    out_dir: Option<String>,
    segment_secs: Option<f64>,
) -> Result<Vec<AudioChunk>, String> {
    let source = PathBuf::from(path);
    let out = match out_dir {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join("t9editorlit").join("chunks"),
    };
    audio::extract_chunks(&source, &out, segment_secs.unwrap_or(300.0))
}

/// Detect silent spans (dead air) in a source's audio with FFmpeg.
///
/// Returns time ranges so the frontend can mark them cut. Pass
/// `minSecs` ≥ ~0.8 to only remove real pauses, keeping the edit natural.
#[tauri::command]
fn detect_silence(
    path: String,
    noise_db: Option<f64>,
    min_secs: Option<f64>,
) -> Result<Vec<audio::SilenceRange>, String> {
    audio::detect_silence(&PathBuf::from(path), noise_db.unwrap_or(-30.0), min_secs.unwrap_or(0.8))
}

/// Default on-disk SQLite path for transcript/cut state.
#[tauri::command]
fn default_db_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("t9editorlit.db").to_string_lossy().into_owned())
}

/// Default directory for extracted audio chunks.
#[tauri::command]
fn default_chunk_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("chunks").to_string_lossy().into_owned())
}

/// Root of the derived-media cache (thumbnail frames live here; waveform
/// peaks are cached in SQLite by the `waveform_peaks` command).
#[tauri::command]
fn default_cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    cache_root(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Sample ~1 fps JPEG thumbnails into a per-source disk cache.
///
/// Returns the cache directory plus frame count; the frontend derives each
/// file name (`thumb_00001.jpg`, …) and loads them through the asset protocol.
#[tauri::command]
fn extract_thumbnails(
    app: tauri::AppHandle,
    path: String,
    out_dir: Option<String>,
    fps: Option<f64>,
    width: Option<u32>,
) -> Result<ThumbnailStrip, String> {
    let source = PathBuf::from(path);
    let root = match out_dir {
        Some(d) => PathBuf::from(d),
        None => cache_root(&app)?,
    };
    thumbnail::extract(&source, &root, fps, width)
}

/// Waveform peaks for the timeline, cached as JSON on disk keyed by source
/// mtime. Streams FFmpeg through a fixed 32 KB buffer — a 5 GB source never
/// lands in this process's heap.
#[tauri::command]
fn extract_waveform(
    app: tauri::AppHandle,
    path: String,
    out_dir: Option<String>,
    bars: Option<u32>,
) -> Result<WaveformData, String> {
    let source = PathBuf::from(path);
    let root = match out_dir {
        Some(d) => PathBuf::from(d),
        None => cache_root(&app)?,
    };
    waveform::extract(&source, &root, bars.unwrap_or(1200) as usize)
}

/// Load transcript lines for a source video from SQLite.
#[tauri::command]
fn load_transcript(db_path: String, source_path: String) -> Result<Vec<TranscriptLine>, String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::load_transcript(&conn, &source_path)
}

/// Replace the stored transcript for a source video.
#[tauri::command]
fn save_transcript(
    db_path: String,
    source_path: String,
    lines: Vec<TranscriptLine>,
) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::save_transcript(&conn, &source_path, &lines)
}

/// Flip the keep/cut decision for one transcript line.
#[tauri::command]
fn set_transcript_keep(
    db_path: String,
    source_path: String,
    id: String,
    keep: bool,
) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::set_keep(&conn, &source_path, &id, keep)
}

/// Save (upsert) a project row so it appears in the Recent Projects grid.
#[tauri::command]
fn save_project(
    db_path: String,
    id: String,
    name: String,
    source_path: String,
    duration_secs: f64,
    last_opened: i64,
) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::save_project(&conn, &id, &name, &source_path, duration_secs, last_opened)
}

/// List all projects, most recently opened first.
#[tauri::command]
fn load_projects(db_path: String) -> Result<Vec<Project>, String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::load_projects(&conn)
}

/// Mark a project as opened now (updates `last_opened`).
#[tauri::command]
fn update_project_opened(db_path: String, source_path: String, last_opened: i64) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::update_project_opened(&conn, &source_path, last_opened)
}

/// Polish render: background music with optional sidechain ducking and text
/// overlay. Streams through FFmpeg; nothing is buffered in this process.
#[tauri::command]
async fn polish_render(
    app: tauri::AppHandle,
    source: String,
    output: String,
    settings: PolishSettings,
) -> Result<PolishResult, String> {
    let source = PathBuf::from(source);
    let output = PathBuf::from(output);
    polish::run_polish(&app, &source, &output, &settings)
}

/// Start a smart hybrid export. Runs synchronously on a worker thread; progress
/// is streamed to the UI via the `export-progress` event.
#[tauri::command]
fn start_export(
    app: tauri::AppHandle,
    cancel: State<'_, ExportCancel>,
    request: ExportRequest,
) -> Result<ExportResult, String> {
    let flag = Arc::new(AtomicBool::new(false));
    *cancel.lock().map_err(|_| "export lock poisoned".to_string())? = Some(Arc::clone(&flag));
    let result = export::run_export(app, flag, request);
    *cancel.lock().map_err(|_| "export lock poisoned".to_string())? = None;
    result
}

/// Cancel a running export. Safe to call when nothing is running.
#[tauri::command]
fn cancel_export(cancel: State<'_, ExportCancel>) {
    if let Ok(guard) = cancel.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Plan an export without running it — returns the piece breakdown, estimated
/// size, and any warnings so the UI can show a preview before the render.
#[tauri::command]
fn plan_export(
    app: tauri::AppHandle,
    request: ExportRequest,
) -> Result<ExportPlan, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let scan_app = app.clone();
    let on_scan = move |msg: &str| {
        let _ = scan_app.emit("export-progress", serde_json::json!({
            "stage": "scan",
            "pieceIndex": 0,
            "pieceCount": 0,
            "percent": 0.0,
            "message": msg,
        }));
    };
    let (_, plan, _) = export::prepare(&request, Some(cancel), Some(&on_scan))?;
    Ok(plan)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(memory::MemoryProbe::new()))
        .manage(Mutex::new(None::<Arc<AtomicBool>>))
.invoke_handler(tauri::generate_handler![
            get_memory_stats,
            probe_media,
            detect_hardware,
            check_ffmpeg,
            extract_audio_chunks,
            detect_silence,
            default_db_path,
            default_chunk_dir,
            default_cache_dir,
            extract_thumbnails,
            load_transcript,
            save_transcript,
            set_transcript_keep,
            save_project,
            load_projects,
            update_project_opened,
            extract_waveform,
            start_export,
            cancel_export,
            plan_export,
            polish_render
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
