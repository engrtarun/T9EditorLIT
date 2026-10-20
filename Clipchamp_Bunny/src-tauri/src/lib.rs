//! Nanami Cut — Rust core.
//!
//! The **media engine is shared** with the T9EditorLIT crate: every module is
//! included by path, so there is exactly one implementation of the FFmpeg,
//! SQLite, export, waveform, thumbnail and memory code in the repository.
//! Nothing is copied — a fix in the engine lands in both apps.
//!
//! The modules are declared at the *crate root* (not nested) because they
//! refer to each other through `crate::` paths.

#[path = "../../../src-tauri/src/audio.rs"]
mod audio;
#[path = "../../../src-tauri/src/cache.rs"]
mod cache;
#[path = "../../../src-tauri/src/env.rs"]
mod env;
#[path = "../../../src-tauri/src/export.rs"]
mod export;
#[path = "../../../src-tauri/src/ffmpeg.rs"]
mod ffmpeg;
#[path = "../../../src-tauri/src/keyframes.rs"]
mod keyframes;
#[path = "../../../src-tauri/src/media.rs"]
mod media;
#[path = "../../../src-tauri/src/memory.rs"]
mod memory;
#[path = "../../../src-tauri/src/polish.rs"]
mod polish;
#[path = "../../../src-tauri/src/thumbnail.rs"]
mod thumbnail;
#[path = "../../../src-tauri/src/transcript.rs"]
mod transcript;
#[path = "../../../src-tauri/src/waveform.rs"]
mod waveform;

mod sysinfo_ext;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

pub use audio::AudioChunk;
pub use env::{EnvEntry, EnvInfo};
pub use export::{ExportOptions, ExportPlan, ExportProgress, ExportRequest, ExportResult, Piece, Segment};
pub use ffmpeg::HardwareSupport;
pub use media::{MediaInfo, StreamInfo};
pub use memory::{MemoryProbe, MemoryStats};
pub use polish::{PolishResult, PolishSettings};
pub use thumbnail::ThumbnailStrip;
pub use transcript::{Project, TranscriptLine};
pub use waveform::WaveformData;

type ExportCancel = Mutex<Option<Arc<AtomicBool>>>;
type Probe = Mutex<memory::MemoryProbe>;

/// `<app_data>/cache` — home for waveform JSON and thumbnail frames.
fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("cache"))
}

/* ================================================================ commands */

/// Live memory reading for the top-bar meter.
#[tauri::command]
fn get_memory_stats(probe: State<'_, Probe>) -> Result<MemoryStats, String> {
    probe
        .lock()
        .map(|mut p| p.sample())
        .map_err(|_| "memory probe lock was poisoned".to_string())
}

/// Full machine snapshot for the "PC details" popover.
#[tauri::command]
fn system_details() -> Result<sysinfo_ext::SystemDetails, String> {
    Ok(sysinfo_ext::collect())
}

/// Locate the demo source so the app has something to show on the very first
/// run, before the user has imported anything.
///
/// The search is deliberately **independent of the working directory**: a
/// shortcut pinned to the taskbar starts the app from wherever Explorer feels
/// like, and a path built from `cwd` would silently stop resolving — which is
/// how the app used to fall back to the mock transcript on desktop.
///
/// The path that comes back is canonical, so it is also the right key for the
/// SQLite cache.
#[tauri::command]
fn demo_source_path(app: tauri::AppHandle) -> Result<Option<String>, String> {
    const DEMO: &str = "resource_Clipchamp/clipchamp_OBSrecord.mp4";

    let mut candidates: Vec<PathBuf> = Vec::new();

    // Packaged resource folder (installer build).
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join(DEMO));
        candidates.push(dir.join("clipchamp_OBSrecord.mp4"));
    }

    // The executable's folder and every folder above it — four levels climbs
    // from `target/release` to the repository root.
    if let Some(exe) = std::env::current_exe().ok()
        && let Some(dir) = exe.parent()
    {
        let mut up = dir.to_path_buf();
        for _ in 0..4 {
            candidates.push(up.join(DEMO));
            let Some(parent) = up.parent().map(Path::to_path_buf) else {
                break;
            };
            up = parent;
        }
    }

    // The working directory, as a last resort for a plain `cargo run`.
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(DEMO));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join(DEMO));
        }
    }

    for c in candidates {
        if c.is_file() {
            return Ok(Some(transcript::canonical_path(
                &c.to_string_lossy(),
            )));
        }
    }
    Ok(None)
}

/// Is `yt-dlp` on PATH? Used to enable the "import from a link" option.
#[tauri::command]
fn check_yt_dlp() -> Result<bool, String> {
    Ok(ffmpeg::run("yt-dlp", &["--version"]).map(|o| o.success()).unwrap_or(false))
}

/// Download a video from a URL with `yt-dlp` (YouTube and friends).
///
/// `yt-dlp` streams straight to disk — the bytes never pass through this
/// process's heap, exactly like the FFmpeg paths. Returns the written path.
#[tauri::command]
fn download_from_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("URL khaali hai".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("sirf http(s) URL chalega".to_string());
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // yt-dlp names the file after the video id.
    let template = dir.join("%(id)s.%(ext)s");

    let out = ffmpeg::run(
        "yt-dlp",
        &[
            "--no-playlist",
            "--no-warnings",
            "--newline",
            "-f",
            "bv*[height<=1080][vcodec!*=av01]+ba/b[height<=1080]/bv*[height<=1080]/b",
            "--merge-output-format",
            "mp4",
            "-o",
            &template.to_string_lossy(),
            &url,
        ],
    )
    .map_err(|e| format!("yt-dlp chal nahi paya: {e}"))?;

    if !out.success() {
        let tail: Vec<&str> = out.stderr.lines().rev().take(4).collect();
        return Err(format!(
            "yt-dlp fail hua: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
        ));
    }

    // Find the newest file the download produced.
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("mp4") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .map_err(|e| e.to_string())?;
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, path));
        }
    }

    newest
        .map(|(_, p)| p.to_string_lossy().into_owned())
        .ok_or_else(|| "yt-dlp ne koi mp4 nahi banayi".to_string())
}

/// Inspect a media file: duration, size, resolution, fps, codecs.
/// Cached in SQLite keyed by path + size + mtime.
#[tauri::command]
fn probe_media(app: tauri::AppHandle, path: String) -> Result<MediaInfo, String> {
    let path = PathBuf::from(path);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_path = dir.join("nanamicut.db");
    let conn = transcript::open_db(&db_path)?;
    media::init_media_cache_schema(&conn)?;
    MediaInfo::probe_cached(&path, &conn)
}

/// Which hardware encoders this machine can actually use.
#[tauri::command]
fn detect_hardware() -> Result<HardwareSupport, String> {
    Ok(HardwareSupport::detect())
}

/// Cheap liveness check so the UI can show a clear "FFmpeg not found" message.
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
        None => std::env::temp_dir().join("nanamicut").join("chunks"),
    };
    audio::extract_chunks(&source, &out, segment_secs.unwrap_or(300.0))
}

/// Detect silent spans (dead air) with FFmpeg's `silencedetect` filter.
/// Clipchamp's AI auto-cut uses ~3 s pauses; `minSecs` controls the floor.
#[tauri::command]
fn detect_silence(
    path: String,
    noise_db: Option<f64>,
    min_secs: Option<f64>,
) -> Result<Vec<audio::SilenceRange>, String> {
    audio::detect_silence(
        &PathBuf::from(path),
        noise_db.unwrap_or(-30.0),
        min_secs.unwrap_or(3.0),
    )
}

/// Default on-disk SQLite path for transcript/cut state.
#[tauri::command]
fn default_db_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("nanamicut.db").to_string_lossy().into_owned())
}

/// Default directory for extracted audio chunks.
#[tauri::command]
fn default_chunk_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("chunks").to_string_lossy().into_owned())
}

/// Root of the derived-media cache.
#[tauri::command]
fn default_cache_dir(app: tauri::AppHandle) -> Result<String, String> {
    cache_root(&app).map(|p| p.to_string_lossy().into_owned())
}

/// Sample ~1 fps JPEG thumbnails into a per-source disk cache.
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

/// Waveform peaks for the timeline, cached as JSON on disk.
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
    waveform::extract(&source, &root, bars.unwrap_or(4096) as usize)
}

/// Load transcript lines for a source video from SQLite.
#[tauri::command]
fn load_transcript(
    db_path: String,
    source_path: String,
) -> Result<Vec<TranscriptLine>, String> {
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

/// Save (upsert) a project row.
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

/// Mark a project as opened now.
#[tauri::command]
fn update_project_opened(
    db_path: String,
    source_path: String,
    last_opened: i64,
) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::update_project_opened(&conn, &source_path, last_opened)
}

/// Polish render: background music with optional sidechain ducking and text overlay.
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

/// Start a smart hybrid export; progress is streamed via `export-progress`.
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

/// Cancel a running export.
#[tauri::command]
fn cancel_export(cancel: State<'_, ExportCancel>) {
    if let Ok(guard) = cancel.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// Plan an export without running it.
#[tauri::command]
fn plan_export(app: tauri::AppHandle, request: ExportRequest) -> Result<ExportPlan, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    let scan_app = app.clone();
    let on_scan = move |msg: &str| {
        let _ = scan_app.emit(
            "export-progress",
            serde_json::json!({
                "stage": "scan",
                "pieceIndex": 0,
                "pieceCount": 0,
                "percent": 0.0,
                "message": msg,
            }),
        );
    };
    let (_, plan, _) = export::prepare(&request, Some(cancel), Some(&on_scan))?;
    Ok(plan)
}

/* ================================================================== runner */

/// Port the `t9cloud` cloud daemon listens on.
const DAEMON_PORT: u16 = 7878;

/** Is the cloud daemon already listening? */
fn daemon_is_up() -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr = SocketAddr::from(([127, 0, 0, 1], DAEMON_PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/**
 * Start `t9cloud` in the background when it is not already running.
 *
 * The app needs the daemon for transcription, for the Gemini flags and for the
 * network meter. When the app is launched from the taskbar there is no
 * terminal to run the launcher script, so the app brings its own cloud brain
 * up: hidden, with no console window, and only if the port is still free.
 *
 * The daemon binary is looked for next to the executable (the installed
 * layout) and then in `go/bin` of the repository checkout.
 */
fn ensure_daemon(app: &tauri::AppHandle) {
    if daemon_is_up() {
        return;
    }

    let Some(exe) = std::env::current_exe().ok() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };

    // The executable folder, then every folder above it — four levels is
    // enough to climb from `target/release` to the repository root.
    let mut roots: Vec<PathBuf> = vec![dir.to_path_buf()];
    let mut up = dir.to_path_buf();
    for _ in 0..4 {
        let Some(parent) = up.parent().map(Path::to_path_buf) else {
            break;
        };
        up = parent;
        roots.push(up.clone());
    }

    let daemon = roots
        .iter()
        .map(|r| r.join("t9cloud.exe"))
        .chain(roots.iter().map(|r| r.join("go").join("bin").join("t9cloud.exe")))
        .find(|p| p.is_file());
    let Some(daemon) = daemon else {
        return;
    };

    // The daemon reads its API keys from a `.env` file.
    let env_file = roots.iter().map(|r| r.join(".env")).find(|p| p.is_file());

    let mut cmd = std::process::Command::new(&daemon);
    if let Some(env_file) = env_file {
        cmd.arg("-env").arg(env_file);
    }

    // The daemon's output goes to a log file next to the database, so a
    // transcription failure can be read without a console attached.
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(log) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("t9cloud.log"))
            && let Ok(err_log) = log.try_clone()
        {
            cmd.stdout(std::process::Stdio::from(log));
            cmd.stderr(std::process::Stdio::from(err_log));
        }
    }
    cmd.stdin(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — no console flashing behind the app.
        cmd.creation_flags(0x0800_0000);
    }

    let _ = cmd.spawn();
}

/** The canonical spelling of a path — one string that always means one file. */
#[tauri::command]
fn canonical_source_path(path: String) -> Result<String, String> {
    Ok(transcript::canonical_path(&path))
}

/**
 * The source path of the project the user last worked on, if its file is still
 * on disk. This is what the app opens on start-up, so it lands on the real
 * video instead of the demo recording.
 */
#[tauri::command]
fn resume_project(db_path: String) -> Result<Option<String>, String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::resume_project(&conn)
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
            system_details,
            demo_source_path,
            canonical_source_path,
            resume_project,
            check_yt_dlp,
            download_from_url,
            probe_media,
            detect_hardware,
            check_ffmpeg,
            extract_audio_chunks,
            detect_silence,
            default_db_path,
            default_chunk_dir,
            default_cache_dir,
            extract_thumbnails,
            extract_waveform,
            load_transcript,
            save_transcript,
            set_transcript_keep,
            save_project,
            load_projects,
            update_project_opened,
            start_export,
            cancel_export,
            plan_export,
            polish_render
        ])
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("T9 Editor LIT — dev")?;
            }
            // The cloud brain comes up with the app - no terminal needed.
            ensure_daemon(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running T9 Editor LIT");
}
