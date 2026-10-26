//! Where the background (video or still wallpaper) lives on disk.
//!
//! The dashboard plays a looping clip behind the UI, and from this version the
//! user can point it at **their own** file. Two rules shape everything here:
//!
//! 1. **Nothing large is ever resident in RAM** (AGENTS.md §1). The frontend
//!    only ever receives a *path*; the webview streams the bytes through
//!    Tauri's `asset://` protocol, which answers HTTP `Range` requests by
//!    seeking in the file. No `fetch()`, no blob, no base64.
//!
//! 2. **A wallpaper must not cost a laptop its battery.** That is why an
//!    import is normalised instead of copied blindly: a 4K/60 fps clip is
//!    decoded thirty times a second and its frame is ~35 MB in the
//!    compositor, while a 720p/30 fps frame is ~1.4 MB. The limits below are
//!    the whole performance story of this feature:
//!
//!        · 3 minutes of video  — a loop, not a movie (duration costs disk,
//!                                 never RAM: one frame is decoded at a time),
//!        · 1920×1080            — the screen's own size, ~3 MB per frame;
//!                                 4K sources are accepted and stored here,
//!        · ≤ 30 fps             — the dashboard does not move that fast,
//!        · no audio             — a wallpaper that talks is a bug,
//!        · H.264 in MP4         — the only codec WebView2 plays everywhere
//!                                 (measured: HEVC and QuickTime report an
//!                                 empty `canPlayType`, MKV is hit-and-miss).
//!        · 3840 px stills       — decoded once, so a 4K wallpaper is fine.
//!
//!    A source that already fits every limit is never re-encoded: an MP4 is
//!    copied byte-for-byte, and any other container holding H.264 is remuxed
//!    (`-c copy`), which is instant and lossless. Only a file that really is
//!    too big, too long, too fast or in another codec costs a transcode.
//!
//! The default clip (`leatTokyo.mp4`) still ships with the app and is still
//! found by the candidate search below; a custom background simply sits in
//! front of it, and "back to default" deletes the custom copy.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// The file that ships with the app.
const BG_NAME: &str = "leatTokyo.mp4";
/// Home of the master copy in the repository.
const BG_REPO: &str = "resource_Clipchamp/leatTokyo.mp4";
/// The same file inside the bundled frontend (`public/assets/…` → `dist/…`).
const BG_ASSET: &str = "assets/leatTokyo.mp4";

/* ------------------------------------------------------------------ limits */

/// Longer than this and it is not a background any more.
///
/// **Duration costs disk, not RAM.** A 3-minute loop decodes exactly one frame
/// at a time, just like a 20-second one; what grows is the file (tens of MB)
/// and the one-time conversion. That is why this cap is generous while the
/// resolution cap below is not.
const MAX_SECONDS: f64 = 180.0;
/// 1080p: ~3 MB per decoded frame instead of ~12 MB for 4K.
///
/// This is the number that decides what the app costs every second it is open,
/// so it follows the screen, not the source file: on a 1920×1080 panel at 125 %
/// scaling the window is 1536 CSS px, i.e. 1920 device px — 1080p is exactly
/// native, and 4K would be four times the decoder work for zero extra pixels.
/// A 4K *source* is still accepted; it is simply stored at this size.
const MAX_VIDEO_W: u32 = 1920;
const MAX_VIDEO_H: u32 = 1080;
/// 60 fps of wallpaper is pure waste on a low-power GPU.
const MAX_FPS: f64 = 30.0;
/// A still is decoded once, so a real 4K wallpaper is allowed here — it costs
/// one bitmap while it is on screen, not a stream of them.
const MAX_IMAGE_EDGE: u32 = 3840;
/// Anything already inside every limit is copied, never re-encoded.
const COPY_BYTES: u64 = 160 * 1024 * 1024;

/* ------------------------------------------------------------------- types */

/// What the frontend needs to paint the background, and nothing else.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    /// `default` (the bundled clip), `video` or `image`.
    pub kind: String,
    /// Absolute path to stream. `None` when even the bundled clip is missing.
    pub path: Option<String>,
    /// First-frame still, painted before the video's first frame and left on
    /// screen if the file ever fails to decode.
    pub poster: Option<String>,
    /// The name the user picked, for the menu's preview line.
    pub label: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub seconds: Option<f64>,
    pub bytes: Option<u64>,
}

/// `backgrounds/state.json` — the only record of what the user chose.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    kind: String,
    /// File name inside `backgrounds/`, never a path.
    file: String,
    poster: Option<String>,
    label: String,
    width: u32,
    height: u32,
    seconds: Option<f64>,
}

/// Progress event, so the menu can show a bar instead of freezing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    pct: f64,
    stage: &'static str,
}

/// One flag, shared by the running ffmpeg child and the Cancel button.
fn cancel_flag() -> Arc<AtomicBool> {
    static FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    Arc::clone(FLAG.get_or_init(|| Arc::new(AtomicBool::new(false))))
}

/* ------------------------------------------------------------- the default */

/// A path only counts when it is a real file; the string form is what the
/// frontend passes to `convertFileSrc`.
fn file(path: &Path) -> Option<String> {
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Every place the bundled clip might already be, cheapest answer first.
fn candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    if let Some(exe) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        let mut up = exe;
        for _ in 0..5 {
            out.push(up.join(BG_REPO));
            out.push(up.join("assets").join(BG_NAME));
            out.push(up.join(BG_NAME));
            match up.parent() {
                Some(parent) => up = parent.to_path_buf(),
                None => break,
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(BG_REPO));
        out.push(cwd.join("assets").join(BG_NAME));
        if let Some(parent) = cwd.parent() {
            out.push(parent.join(BG_REPO));
        }
    }

    if let Ok(dir) = app.path().resource_dir() {
        out.push(dir.join(BG_REPO));
        out.push(dir.join(BG_NAME));
        out.push(dir.join("assets").join(BG_NAME));
    }

    if let Ok(dir) = app.path().app_local_data_dir() {
        out.push(dir.join("assets").join(BG_NAME));
    }

    out
}

/// Write the embedded copy out once, so it can be range-requested from disk.
fn extract(app: &tauri::AppHandle) -> Option<String> {
    let dir = app.path().app_local_data_dir().ok()?.join("assets");
    let target = dir.join(BG_NAME);
    if let Some(existing) = file(&target) {
        return Some(existing);
    }

    let asset = app.asset_resolver().get(BG_ASSET.to_string())?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::write(&target, &asset.bytes).ok()?;
    file(&target)
}

/// The bundled clip, or `None` when it cannot be found anywhere.
pub fn resolve(app: &tauri::AppHandle) -> Option<String> {
    candidates(app)
        .iter()
        .find_map(|c| file(c))
        .or_else(|| extract(app))
}

/* ------------------------------------------------------------ custom state */

fn backgrounds_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("cannot find the app data folder: {e}"))?;
    let dir = base.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn stored(app: &tauri::AppHandle) -> Option<Stored> {
    let dir = backgrounds_dir(app).ok()?;
    let raw = std::fs::read_to_string(dir.join("state.json")).ok()?;
    let state: Stored = serde_json::from_str(&raw).ok()?;
    dir.join(&state.file).is_file().then_some(state)
}

fn write_state(app: &tauri::AppHandle, state: &Stored) -> Result<(), String> {
    let dir = backgrounds_dir(app)?;
    let tmp = dir.join("state.tmp");
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("cannot write the background record: {e}"))?;
    std::fs::rename(&tmp, dir.join("state.json"))
        .map_err(|e| format!("cannot save the background record: {e}"))
}

fn remove_where(dir: &Path, matches: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if matches(&name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Millisecond stamp, so a new background never reuses the live file's name.
///
/// The webview is usually still streaming the *old* file while the new one is
/// being written (the dashboard keeps playing during a conversion). On Windows
/// a delete or an overwrite of that open file fails, so the importer never
/// touches it: it writes a brand-new name, points `state.json` at it, and only
/// then deletes whatever is no longer referenced — best effort, because a
/// locked orphan is harmless and gets pruned by the next import.
fn unique_name(prefix: &str, ext: &str) -> String {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{prefix}-{stamp}.{ext}")
}

/// Drop everything the importer produced except what the state now points at.
fn prune(dir: &Path, keep_file: &str, keep_poster: Option<&str>) {
    remove_where(dir, |name| {
        if name == keep_file || Some(name) == keep_poster {
            return false;
        }
        name.starts_with("current") || name.starts_with("poster") || name.starts_with("incoming")
    });
}

/// Delete every produced file, so "back to default" really frees the disk.
fn clear_produced(dir: &Path) {
    remove_where(dir, |name| {
        name.starts_with("current")
            || name.starts_with("poster")
            || name.starts_with("incoming")
            || name == "state.json"
            || name == "state.tmp"
    });
}

/// The whole answer for the frontend: custom file if there is one, else the
/// bundled clip.
fn current(app: &tauri::AppHandle) -> BackgroundState {
    if let Some(state) = stored(app) {
        if let Ok(dir) = backgrounds_dir(app) {
            let path = dir.join(&state.file);
            let poster = state
                .poster
                .as_ref()
                .map(|p| dir.join(p))
                .filter(|p| p.is_file());
            return BackgroundState {
                kind: state.kind,
                path: Some(path.to_string_lossy().into_owned()),
                poster: poster.map(|p| p.to_string_lossy().into_owned()),
                label: Some(state.label),
                width: Some(state.width),
                height: Some(state.height),
                seconds: state.seconds,
                bytes: std::fs::metadata(&path).ok().map(|m| m.len()),
            };
        }
    }

    BackgroundState {
        kind: "default".to_string(),
        path: resolve(app),
        ..Default::default()
    }
}

/* ------------------------------------------------------------------- probe */

struct Media {
    width: u32,
    height: u32,
    codec: String,
    fps: f64,
    seconds: f64,
}

fn parse_rate(text: &str) -> Option<f64> {
    let (num, den) = text.split_once('/')?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    (den > 0.0 && num > 0.0).then(|| num / den)
}

fn probe(path: &Path) -> Result<Media, String> {
    let raw = crate::ffmpeg::ffprobe_json(path)?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("ffprobe returned something unreadable: {e}"))?;

    let streams = doc
        .get("streams")
        .and_then(|s| s.as_array())
        .ok_or_else(|| "ffprobe found no streams in that file".to_string())?;

    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("video"))
        .ok_or_else(|| "that file has no picture in it".to_string())?;

    let width = video.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let height = video.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    if width < 2 || height < 2 {
        return Err("that file has no usable picture".to_string());
    }

    let codec = video
        .get("codec_name")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();

    let fps = video
        .get("avg_frame_rate")
        .and_then(|x| x.as_str())
        .and_then(parse_rate)
        .unwrap_or(0.0);

    let seconds = doc
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .or_else(|| {
            video
                .get("duration")
                .and_then(|d| d.as_str())
                .and_then(|d| d.parse::<f64>().ok())
        })
        .unwrap_or(0.0);

    Ok(Media {
        width,
        height,
        codec,
        fps,
        seconds,
    })
}

/* ------------------------------------------------------------------ import */

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn is_image_ext(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif" | "bmp" | "tif" | "tiff"
    )
}

fn is_video_ext(ext: &str) -> bool {
    matches!(
        ext,
        "mp4"
            | "m4v"
            | "mov"
            | "mkv"
            | "webm"
            | "avi"
            | "wmv"
            | "mpg"
            | "mpeg"
            | "ts"
            | "mts"
            | "m2ts"
            | "flv"
            | "3gp"
            | "ogv"
    )
}

/// Formats WebView2 can paint without any help.
fn is_web_image(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "avif" | "gif")
}

fn emit(app: &tauri::AppHandle, pct: f64, stage: &'static str) {
    let _ = app.emit(
        "background:progress",
        Progress {
            pct: pct.clamp(0.0, 100.0),
            stage,
        },
    );
}

/// Video → H.264 MP4, at most 20 s, ≤ 720p, ≤ 30 fps, silent.
fn transcode_video(
    app: &tauri::AppHandle,
    src: &Path,
    dst: &Path,
    media: &Media,
) -> Result<(), String> {
    // Literal numbers, computed here: an ffmpeg expression would need quoting
    // rules that differ between shells, and `min(2560,iw)` inside a filter is
    // a comma away from being parsed as two filters.
    let box_w = media.width.min(MAX_VIDEO_W).max(2);
    let box_h = media.height.min(MAX_VIDEO_H).max(2);
    let scale = format!(
        "scale={box_w}:{box_h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    );

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        // Input-side `-t`: ffmpeg stops reading after the cap, so a two-hour 4K
        // recording costs that much decode, not two hours of it.
        "-t".into(),
        format!("{MAX_SECONDS}"),
        "-i".into(),
        src.to_string_lossy().into_owned(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        scale,
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        "veryfast".into(),
        "-crf".into(),
        "26".into(),
        "-profile:v".into(),
        "high".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-maxrate".into(),
        "4000k".into(),
        "-bufsize".into(),
        "8000k".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    if media.fps > MAX_FPS + 0.5 {
        args.push("-r".into());
        args.push("30".into());
    }
    args.push(dst.to_string_lossy().into_owned());

    let total = media.seconds.clamp(1.0, MAX_SECONDS);
    let flag = cancel_flag();
    flag.store(false, Ordering::SeqCst);

    let mut last = -10.0_f64;
    let handle = app.clone();
    let out = crate::ffmpeg::run_streaming("ffmpeg", &args, Some(flag), |line| {
        let micros = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
            .and_then(|v| v.trim().parse::<f64>().ok());
        if let Some(us) = micros {
            let pct = us / 1_000_000.0 / total * 100.0;
            if pct - last >= 1.5 {
                last = pct;
                emit(&handle, pct, "convert");
            }
        }
    })?;

    if out.cancelled {
        return Err("cancelled".to_string());
    }
    if !out.success() {
        let tail = out.stderr_tail.trim();
        let detail = tail.lines().last().unwrap_or("ffmpeg refused the file");
        return Err(format!("could not convert that video: {detail}"));
    }
    Ok(())
}

/// One still frame, so the menu has a preview and the video has a poster.
fn make_poster(src: &Path, dst: &Path) -> Result<(), String> {
    let source = src.to_string_lossy().into_owned();
    let target = dst.to_string_lossy().into_owned();
    for seek in ["1", "0"] {
        let out = crate::ffmpeg::run(
            "ffmpeg",
            &[
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-ss",
                seek,
                "-i",
                &source,
                "-frames:v",
                "1",
                "-vf",
                "scale=960:-2",
                "-q:v",
                "5",
                &target,
            ],
        )?;
        if out.success() && dst.is_file() {
            return Ok(());
        }
    }
    Err("could not read a frame out of that video".to_string())
}

/// Same frames, new container: H.264 that already fits, only boxed in
/// something WebView2 will not demux (`.mov`, `.mkv`, …).
///
/// `-c copy` means no decoder and no encoder run at all — the stream is
/// byte-copied into an MP4 and `+faststart` moves the index to the front, so
/// playback can start from the first range request.
fn remux_video(src: &Path, dst: &Path) -> Result<(), String> {
    let source = src.to_string_lossy().into_owned();
    let target = dst.to_string_lossy().into_owned();
    let out = crate::ffmpeg::run(
        "ffmpeg",
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            &source,
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-an",
            "-sn",
            "-dn",
            "-movflags",
            "+faststart",
            &target,
        ],
    )?;
    if !out.success() || !dst.is_file() {
        let _ = std::fs::remove_file(dst);
        return Err("that video could not be repackaged".to_string());
    }
    Ok(())
}

fn import_video(
    app: &tauri::AppHandle,
    dir: &Path,
    src: &Path,
    ext: &str,
    media: &Media,
) -> Result<BackgroundState, String> {
    let bytes = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);

    // Everything a wallpaper needs is already in this file: H.264, small,
    // short, light. Whether it can be reused depends only on the *container*,
    // because WebView2 decides how to demux from the MIME type the path
    // produces (`.mov` is `video/quicktime`, which it reports as unsupported).
    let fits = media.codec == "h264"
        && media.width <= MAX_VIDEO_W
        && media.height <= MAX_VIDEO_H
        && media.seconds > 0.0
        && media.seconds <= MAX_SECONDS
        && bytes <= COPY_BYTES;
    let is_mp4 = matches!(ext, "mp4" | "m4v");
    let copy_as_is = fits && is_mp4;

    let tmp = dir.join("incoming.mp4");
    let _ = std::fs::remove_file(&tmp);

    if copy_as_is {
        emit(app, 40.0, "copy");
        std::fs::copy(src, &tmp).map_err(|e| format!("could not copy that file: {e}"))?;
        emit(app, 85.0, "poster");
    } else if fits {
        // Same frames, new box: no decoder, no encoder, no generation loss.
        emit(app, 40.0, "copy");
        remux_video(src, &tmp)?;
        emit(app, 85.0, "poster");
    } else {
        emit(app, 0.0, "convert");
        transcode_video(app, src, &tmp, media)?;
        emit(app, 90.0, "poster");
    }

    if !tmp.is_file() {
        return Err("the video could not be prepared".to_string());
    }

    let poster_tmp = dir.join("incoming-poster.jpg");
    let _ = std::fs::remove_file(&poster_tmp);
    let poster = make_poster(&tmp, &poster_tmp).is_ok();

    // The produced file is the truth about size and length, not the source.
    let made = probe(&tmp).unwrap_or(Media {
        width: media.width,
        height: media.height,
        codec: "h264".to_string(),
        fps: media.fps,
        seconds: media.seconds.min(MAX_SECONDS),
    });

    // Everything is ready; only now does the old background stop being used.
    let file = unique_name("current", "mp4");
    std::fs::rename(&tmp, dir.join(&file))
        .map_err(|e| format!("could not store the background: {e}"))?;

    let mut poster_name = None;
    if poster {
        let name = unique_name("poster", "jpg");
        if std::fs::rename(&poster_tmp, dir.join(&name)).is_ok() {
            poster_name = Some(name);
        }
    }

    write_state(
        app,
        &Stored {
            kind: "video".to_string(),
            file: file.clone(),
            poster: poster_name.clone(),
            label: src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "custom video".to_string()),
            width: made.width,
            height: made.height,
            seconds: Some(made.seconds.min(MAX_SECONDS)),
        },
    )?;

    prune(dir, &file, poster_name.as_deref());

    emit(app, 100.0, "done");
    Ok(current(app))
}

fn import_image(
    app: &tauri::AppHandle,
    dir: &Path,
    src: &Path,
    ext: &str,
    media: &Media,
) -> Result<BackgroundState, String> {
    let longest = media.width.max(media.height);
    let copy_as_is = is_web_image(ext) && longest <= MAX_IMAGE_EDGE;

    let (file_name, width, height) = if copy_as_is {
        // WebView2 paints this format natively and it already fits: keep the
        // exact bytes the user picked.
        let name = unique_name("current", ext);
        let incoming = dir.join(format!("incoming.{ext}"));
        let _ = std::fs::remove_file(&incoming);
        std::fs::copy(src, &incoming).map_err(|e| format!("could not copy that image: {e}"))?;
        std::fs::rename(&incoming, dir.join(&name))
            .map_err(|e| format!("could not store the wallpaper: {e}"))?;
        (name, media.width, media.height)
    } else {
        // Anything the webview cannot paint (or that is simply too big) becomes
        // a JPEG at most 2560 px on the long edge — decoded once, cheap to keep.
        let vf = if media.width >= media.height {
            let w = MAX_IMAGE_EDGE.min(media.width).max(2);
            format!("scale={w}:-2")
        } else {
            let h = MAX_IMAGE_EDGE.min(media.height).max(2);
            format!("scale=-2:{h}")
        };
        let target = dir.join("incoming.jpg");
        let _ = std::fs::remove_file(&target);
        let source = src.to_string_lossy().into_owned();
        let out = crate::ffmpeg::run(
            "ffmpeg",
            &[
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-i",
                &source,
                "-frames:v",
                "1",
                "-vf",
                &vf,
                "-q:v",
                "3",
                &target.to_string_lossy().into_owned(),
            ],
        )?;
        if !out.success() || !target.is_file() {
            let _ = std::fs::remove_file(&target);
            return Err("that image could not be read".to_string());
        }
        let made = probe(&target).unwrap_or(Media {
            width: media.width,
            height: media.height,
            codec: "mjpeg".to_string(),
            fps: 0.0,
            seconds: 0.0,
        });
        let name = unique_name("current", "jpg");
        std::fs::rename(&target, dir.join(&name))
            .map_err(|e| format!("could not store the wallpaper: {e}"))?;
        (name, made.width, made.height)
    };

    write_state(
        app,
        &Stored {
            kind: "image".to_string(),
            file: file_name.clone(),
            poster: None,
            label: src
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "custom wallpaper".to_string()),
            width,
            height,
            seconds: None,
        },
    )?;

    prune(dir, &file_name, None);

    emit(app, 100.0, "done");
    Ok(current(app))
}

fn import_blocking(app: &tauri::AppHandle, path: &str) -> Result<BackgroundState, String> {
    let src = PathBuf::from(path);
    if !src.is_file() {
        return Err("that file is not there any more".to_string());
    }

    let dir = backgrounds_dir(app)?;
    let ext = ext_of(&src);
    let media = probe(&src)?;
    cancel_flag().store(false, Ordering::SeqCst);

    let result = if is_image_ext(&ext) {
        import_image(app, &dir, &src, &ext, &media)
    } else if is_video_ext(&ext) || media.seconds > 0.0 {
        import_video(app, &dir, &src, &ext, &media)
    } else {
        // Unknown container that ffprobe still read as a still picture.
        import_image(app, &dir, &src, &ext, &media)
    };

    // A failed or cancelled conversion leaves a half-written `incoming.*`
    // behind. It is never referenced by `state.json`, so drop it here instead
    // of letting it sit on the disk until the next attempt.
    if result.is_err() {
        remove_where(&dir, |name| name.starts_with("incoming"));
    }
    result
}

/* ---------------------------------------------------------------- commands */

/// The bundled clip, for backwards compatibility with older frontends.
#[tauri::command]
pub fn background_video_path(app: tauri::AppHandle) -> Option<String> {
    resolve(&app)
}

/// What should be painted right now.
#[tauri::command]
pub fn background_state(app: tauri::AppHandle) -> BackgroundState {
    current(&app)
}

/// Take a file the user picked and make it a wallpaper.
///
/// Runs on a blocking worker so the UI thread never waits for ffmpeg, and
/// watches a cancel flag so the menu's Cancel button really stops the child.
#[tauri::command]
pub async fn background_import(
    app: tauri::AppHandle,
    path: String,
) -> Result<BackgroundState, String> {
    tauri::async_runtime::spawn_blocking(move || import_blocking(&app, &path))
        .await
        .map_err(|e| format!("background import task failed: {e}"))?
}

/// Back to the clip that ships with the app.
#[tauri::command]
pub fn background_reset(app: tauri::AppHandle) -> Result<BackgroundState, String> {
    let dir = backgrounds_dir(&app)?;
    clear_produced(&dir);
    Ok(current(&app))
}

/// Stop an import that is still converting.
#[tauri::command]
pub fn background_cancel() {
    cancel_flag().store(true, Ordering::SeqCst);
}
