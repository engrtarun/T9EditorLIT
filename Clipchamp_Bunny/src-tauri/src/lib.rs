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

mod meters;

pub use meters::{
    set_system_clock, system_snapshot, AppStorageProbe, DriveReading, NetReading, NetworkProbe,
    RamReading, SystemSnapshot,
};

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
pub use transcript::{Project, TranscriptLine, TrashItem};
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

/// How much room is left on the drive that holds the app's data.
///
/// The dashboard's status bar needs one number, and it needs it *now* — so this
/// reads the disk list only, without the CPU sampling `system_details` does.
#[tauri::command]
fn drive_space(app: tauri::AppHandle) -> Result<Option<sysinfo_ext::DriveSpace>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(sysinfo_ext::drive_space(&dir))
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

/* ------------------------------------------------------------------- trash */

/// Move a project out of the dashboard list and into the bin.
///
/// The **video file is not touched** — only the app's row moves, so a restore
/// is instant and never re-transcribes anything.
#[tauri::command]
fn trash_project(db_path: String, source_path: String) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::trash_project(&conn, &source_path)
}

/// Bring a project back from the bin.
#[tauri::command]
fn restore_project(db_path: String, source_path: String) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::restore_project(&conn, &source_path)
}

/// Everything currently in the bin, newest first.
#[tauri::command]
fn load_trash(db_path: String) -> Result<Vec<TrashItem>, String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::load_trash(&conn)
}

/// Forget a binned project for good — the app's record only, never the file.
#[tauri::command]
fn purge_trash(db_path: String, source_path: String) -> Result<(), String> {
    let conn = transcript::open_db(Path::new(&db_path))?;
    transcript::purge_trash(&conn, &source_path)
}

/* ------------------------------------------------------------------ poster */

/// One poster frame for a dashboard card.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Poster {
    /// Absolute path of the cached JPEG on disk.
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// True when the frame was already on disk — no FFmpeg was started.
    pub cached: bool,
}

/// Extract **one** frame from a source, for the dashboard's project cards.
///
/// This is deliberately not `extract_thumbnails`: that one samples the whole
/// video at 1 fps, which means decoding two hours of footage to fill a strip.
/// A card needs a single still, so this seeks straight to it (`-ss` before
/// `-i` = input seek) and grabs one frame.
///
/// The JPEG lands in the on-disk cache, keyed by the source's path + size +
/// mtime, so the second visit to the dashboard costs nothing and a replaced
/// file gets a fresh frame instead of a stale one.
#[tauri::command]
fn extract_poster(
    app: tauri::AppHandle,
    path: String,
    at_secs: Option<f64>,
    width: Option<u32>,
) -> Result<Poster, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err(format!("source file not found: {path}"));
    }

    let meta = std::fs::metadata(&source).map_err(|e| e.to_string())?;
    let key = cache::source_key(&source, &meta)?;
    let root = cache_root(&app)?;
    let dir = root.join("posters");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create poster dir: {e}"))?;
    let out = dir.join(format!("{key}.jpg"));
    let w = width.unwrap_or(480).clamp(64, 1280);

    // The cached still comes **first**: no FFmpeg, no ffprobe, no waiting.
    // A half-written file (size 0) counts as no file at all.
    let cached = out.is_file()
        && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false);
    if cached {
        return Ok(Poster {
            path: out.to_string_lossy().into_owned(),
            width: w,
            height: (w * 9 / 16).max(2),
            cached: true,
        });
    }

    // A little way into the clip: the first frame of a recording is often black.
    let duration = media::MediaInfo::probe(&source)
        .map(|i| i.duration_secs)
        .unwrap_or(0.0);
    let at = at_secs.unwrap_or_else(|| {
        if duration > 0.0 {
            (duration * 0.1).clamp(1.0, 30.0)
        } else {
            1.0
        }
    });

    let vf = format!("scale={w}:-2");
    let status = std::process::Command::new("ffmpeg")
        .args(["-y", "-hide_banner", "-nostats", "-loglevel", "error"])
        .arg("-ss")
        .arg(format!("{at:.3}"))
        .arg("-i")
        .arg(&source)
        .args(["-frames:v", "1", "-vf", &vf, "-q:v", "5", "-f", "image2"])
        .arg(&out)
        .status()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;

    if !status.success() || !out.is_file() {
        let _ = std::fs::remove_file(&out);
        return Err("ffmpeg could not extract a poster frame".to_string());
    }

    Ok(Poster {
        path: out.to_string_lossy().into_owned(),
        width: w,
        height: (w * 9 / 16).max(2),
        cached: false,
    })
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

/* ========================================================== network meter */

/// Download throughput, as the daemon measures it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speed {
    pub mbps: f64,
    pub megabytes_per_sec: f64,
}

/**
 * Ask the cloud daemon how fast the link is.
 *
 * The measurement lives in the **Rust** side on purpose. Doing it from the
 * webview meant the number went through the browser's fetch, and from there
 * it was silently swallowed — the chip stayed on "—" while the daemon was
 * cheerfully answering every request. A plain TCP request has no CORS, no
 * content-security policy and no webview quirks, so the reading either
 * arrives or it fails loudly.
 */
#[tauri::command]
fn measure_network_speed(window_ms: Option<u32>) -> Result<Option<Speed>, String> {
    let ms = window_ms.unwrap_or(2000).clamp(500, 15000);
    let path = format!("/v1/net/speed?windowMs={ms}");

    let Some(body) = http_get_json("127.0.0.1", DAEMON_PORT, &path) else {
        return Ok(None);
    };
    match serde_json::from_str::<Speed>(&body) {
        Ok(speed) => Ok(Some(speed)),
        Err(e) => Err(format!("daemon sent an unreadable speed reading: {e}")),
    }
}

/**
 * The cloud daemon's own health report.
 *
 * Returned as raw JSON because the shape belongs to the Go daemon, not to
 * this app. The UI reads `cloud.transcribe`, `cloud.analyze` and `cloud.vault`
 * to decide which providers are genuinely ready — instead of pretending they
 * are connected.
 */
#[tauri::command]
fn daemon_health() -> Result<Option<serde_json::Value>, String> {
    let Some(body) = http_get_json("127.0.0.1", DAEMON_PORT, "/healthz") else {
        return Ok(None);
    };
    serde_json::from_str(&body)
        .map(Some)
        .map_err(|e| format!("daemon sent an unreadable health report: {e}"))
}

/* ============================================================ self update */

/**
 * The build that is installed next to the running executable.
 *
 * The desktop app updates itself from disk: the deploy script writes a
 * `build.json` marker and, when the app is already running, stages the new
 * executable as `t9-editor-lit.new.exe`. Comparing the marker with the one
 * the app started on tells the user there is a newer build waiting.
 */
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledBuild {
    /// ISO-8601 timestamp of the build that sits in the install folder.
    pub built_at: String,
    /// The version string of that build.
    pub version: String,
    /// True when a newer build is staged and only a restart is needed.
    ///
    /// `default` matters: the marker file on disk (`build.json`) is written by
    /// the deploy script and does **not** carry this field — the answer is
    /// worked out here instead, by looking for the staged executable. Without
    /// the default the whole file would fail to parse and the update button
    /// would never appear.
    #[serde(default)]
    pub update_ready: bool,
}

/// The folder the app was installed into.
fn install_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Read the `build.json` marker the deploy script writes.
#[tauri::command]
fn installed_build() -> Result<Option<InstalledBuild>, String> {
    let Some(dir) = install_dir() else {
        return Ok(None);
    };
    let marker = dir.join("build.json");
    if !marker.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&marker)
        .map_err(|e| format!("could not read {}: {e}", marker.display()))?;
    // A byte-order mark would make the JSON parser choke, and the update
    // button would silently never appear.
    let text = text.trim_start_matches('\u{feff}');
    let mut build: InstalledBuild = serde_json::from_str(text)
        .map_err(|e| format!("could not parse {}: {e}", marker.display()))?;

    // A staged executable means a newer build is waiting to be swapped in.
    build.update_ready = dir.join("t9-editor-lit.new.exe").is_file();
    Ok(Some(build))
}

/**
 * Swap the staged build in and relaunch.
 *
 * Windows will not let a running executable be overwritten, so the swap is
 * done by a tiny helper script: it waits for this process to go away, moves
 * the old binary aside, puts the new one in its place and starts the app
 * again. The pinned taskbar icon keeps working — it points at the same path.
 */
#[tauri::command]
fn apply_staged_update(app: tauri::AppHandle) -> Result<(), String> {
    let Some(dir) = install_dir() else {
        return Err("cannot work out the install folder".to_string());
    };
    let staged = dir.join("t9-editor-lit.new.exe");
    if !staged.is_file() {
        return Err("there is no staged update to apply".to_string());
    }
    // The helper is written fresh every time, so a half-finished earlier
    // attempt cannot leave a broken script behind.
    //
    // Every path in it is **absolute**: a relative path would be resolved
    // against whatever folder the helper happened to start in, and the swap
    // would then quietly do nothing.
    let helper = dir.join("t9-apply-update.cmd");
    let live = dir.join("t9-editor-lit.exe");
    let fresh = dir.join("t9-editor-lit.new.exe");
    let old = dir.join("t9-editor-lit.old.exe");
    let daemon_live = dir.join("t9cloud.exe");
    let daemon_fresh = dir.join("t9cloud.new.exe");
    let daemon_old = dir.join("t9cloud.old.exe");

    let script = format!(
        "@echo off\r\n\
:waitapp\r\n\
tasklist /FI \"IMAGENAME eq t9-editor-lit.exe\" 2>nul | find /I \"t9-editor-lit.exe\" >nul\r\n\
if not errorlevel 1 ping -n 2 127.0.0.1 >nul & goto waitapp\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
taskkill /F /IM t9cloud.exe >nul 2>&1\r\n\
move /Y \"{live}\" \"{old}\" >nul 2>&1\r\n\
move /Y \"{fresh}\" \"{live}\" >nul 2>&1\r\n\
del /Q \"{old}\" >nul 2>&1\r\n\
move /Y \"{daemon_live}\" \"{daemon_old}\" >nul 2>&1\r\n\
move /Y \"{daemon_fresh}\" \"{daemon_live}\" >nul 2>&1\r\n\
del /Q \"{daemon_old}\" >nul 2>&1\r\n\
start \"\" \"{live}\"\r\n",
        live = live.to_string_lossy(),
        old = old.to_string_lossy(),
        fresh = fresh.to_string_lossy(),
        daemon_live = daemon_live.to_string_lossy(),
        daemon_old = daemon_old.to_string_lossy(),
        daemon_fresh = daemon_fresh.to_string_lossy(),
    );
    std::fs::write(&helper, script)
        .map_err(|e| format!("could not write {}: {e}", helper.display()))?;

    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/C")
        .arg(&helper)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW — no console flashes; the app simply restarts.
        cmd.creation_flags(0x0800_0000);
    }

    cmd.spawn()
        .map_err(|e| format!("could not start the update helper: {e}"))?;

    // Give the helper a moment to attach, then close down.
    std::thread::sleep(std::time::Duration::from_millis(400));
    app.exit(0);
    Ok(())
}

/// A minimal HTTP/1.1 GET over a raw socket, returning the body.

/// The daemon is a loopback service that speaks plain HTTP, so this needs no
/// HTTP client crate — which keeps the dependency list (and the build) small.
fn http_get_json(host: &str, port: u16, path: &str) -> Option<String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let mut stream = TcpStream::connect((host, port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok()?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).into_owned();

    // Split the head from the body; a chunked body is not expected here
    // because the daemon sends a plain JSON document.
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") {
        return None;
    }
    Some(body.trim().to_string())
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
pub fn run() {    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(memory::MemoryProbe::new()))
        .manage(Mutex::new(NetworkProbe::new()))
        .manage(AppStorageProbe::new())
        .manage(Mutex::new(None::<Arc<AtomicBool>>))
        .invoke_handler(tauri::generate_handler![
            get_memory_stats,
            system_details,
            drive_space,
            system_snapshot,
            set_system_clock,
            demo_source_path,
            canonical_source_path,
            measure_network_speed,
            daemon_health,
            installed_build,
            apply_staged_update,
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
            trash_project,
            restore_project,
            load_trash,
            purge_trash,
            extract_poster,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The daemon is a plain HTTP service on the loopback interface, so the
    /// hand-rolled GET has to return its body. This test needs the daemon
    /// running; it skips itself when it is not.
    #[test]
    fn http_get_json_reads_the_daemon() {
        let Some(body) = http_get_json("127.0.0.1", DAEMON_PORT, "/healthz") else {
            eprintln!("daemon is not running - skipping");
            return;
        };
        assert!(body.contains("\"ok\""), "unexpected body: {body}");
    }

    #[test]
    fn http_get_json_returns_none_for_a_bad_port() {
        assert!(http_get_json("127.0.0.1", 9, "/healthz").is_none());
    }

    /// The marker the deploy script writes has no `updateReady` field — the
    /// answer is worked out from the staged executable instead. If the parser
    /// demanded the field, the marker would fail to parse and the update
    /// button would silently never appear.
    #[test]
    fn the_deploy_marker_parses_without_an_update_ready_field() {
        let marker = r#"{
  "stagedAt": "2026-10-20T09:52:27.2295144Z",
  "version": "0.1.0",
  "builtAt": "2026-10-20T09:52:27.2144309Z"
}"#;
        let build: InstalledBuild = serde_json::from_str(marker).expect("marker must parse");
        assert_eq!(build.version, "0.1.0");
        assert!(!build.update_ready, "the staged flag is worked out at runtime");
    }

    /// A marker that does carry the field is still fine.
    #[test]
    fn a_marker_with_the_field_parses_too() {
        let marker = r#"{"builtAt":"2026-10-20T09:52:27Z","version":"0.1.0","updateReady":true}"#;
        let build: InstalledBuild = serde_json::from_str(marker).expect("marker must parse");
        assert!(build.update_ready);
    }
}
