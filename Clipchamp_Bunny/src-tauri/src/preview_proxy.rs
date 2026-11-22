//! What the editor's preview surface plays when WebView2 cannot play the source.
//!
//! The problem this solves is **not** file size. A 5 GB file streams through
//! Tauri's `asset://` protocol with HTTP `Range` requests, exactly like a 50 MB
//! one — the webview never holds the file. The wall is the **decoder**:
//!
//! | The user's file                        | WebView2 |
//! | -------------------------------------- | -------- |
//! | H.264 8-bit 4:2:0 in MP4               | plays    |
//! | VP8/VP9/AV1 in WebM                    | plays    |
//! | HEVC / H.265 (phones, cameras, BluRay) | black    |
//! | 10-bit or 4:2:2 / 4:4:4 H.264          | black    |
//! | ProRes, DNxHD, AV1-in-MKV              | black    |
//! | any `.mkv` / `.mov` / `.MTS` container | black    |
//! | AC3 / EAC3 / DTS / TrueHD audio        | silent   |
//!
//! A user drops in a 3.5 GB `x264` episode in an MKV and gets a black screen —
//! the codec is fine, the *container* is not. That case must not cost a
//! transcode: `-c copy` moves the same H.264 stream into an MP4 in seconds,
//! losslessly. Only a file whose picture WebView2 genuinely cannot decode pays
//! for a re-encode, and then it is a small H.264 proxy, not the original.
//!
//! ## The two rules this file obeys
//!
//! 1. **Zero RAM** (AGENTS.md §1). The proxy is written to disk by an FFmpeg
//!    child and streamed back by the webview. Nothing is ever read into this
//!    process's heap, and the source is never copied.
//! 2. **The source is the truth.** A proxy is a *view*, cached under the
//!    source's own cache key. Export, transcription, waveform and filmstrip all
//!    keep reading the original file — only the preview surface points at the
//!    proxy. Replacing the source invalidates the key, so a stale proxy can
//!    never be shown for a different file.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Emitter;

/* ------------------------------------------------------------- what plays */

/// Video codecs WebView2 (Chromium) decodes without help.
const PLAYABLE_VIDEO: &[&str] = &["h264", "vp8", "vp9", "av1"];
/// Audio codecs the same engine decodes. AC3/EAC3/DTS/TrueHD are *not* here —
/// a BluRay rip's default track is usually one of those.
const PLAYABLE_AUDIO: &[&str] = &["aac", "mp3", "opus", "vorbis"];
/// Containers it demuxes.
///
/// `mov` is deliberately absent: the asset protocol serves it as
/// `video/quicktime`, which Edge reports as unsupported, so a `.mov` holding
/// perfect H.264 still shows black. `matroska,webm` is accepted only when the
/// file really is a WebM — see `container_ok`.
const PLAYABLE_CONTAINERS: &[&str] = &["mp4", "m4a", "webm"];
/// The only H.264 pixel formats Chromium decodes: 8-bit 4:2:0.
const PLAYABLE_PIX: &[&str] = &["yuv420p", "yuvj420p", "nv12"];

/// Proxy ceiling. The preview pane is ~900 CSS px wide on a 1080p screen, so
/// 720p is already more pixels than the surface can show. Decoding 1080p
/// instead would double the per-frame cost for no visible gain.
const PROXY_W: u32 = 720;
const PROXY_H: u32 = 720;

/* ---------------------------------------------------------------- types */

/// What the editor should do with one source.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPlan {
    /// `native` (play the source), `remux` (fast copy) or `transcode`.
    pub kind: String,
    /// A sentence for the UI — never a bare error code.
    pub reason: String,
    /// The proxy already on disk, when one was built before.
    pub proxy: Option<String>,
    /// Source length, so the UI can say how long the wait is.
    pub seconds: f64,
    /// True when the source has a picture at all.
    pub has_video: bool,
}

/// The ffprobe facts this decision needs, and nothing else.
struct Source {
    container: String,
    video: String,
    pix: String,
    transfer: String,
    audio: Option<String>,
    width: u32,
    height: u32,
    fps: f64,
    seconds: f64,
    has_video: bool,
}

/// Progress event for the preview stage's bar.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    pct: f64,
    stage: &'static str,
}

/* -------------------------------------------------------------- helpers */

fn cancel_flag() -> Arc<AtomicBool> {
    static FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();
    Arc::clone(FLAG.get_or_init(|| Arc::new(AtomicBool::new(false))))
}

fn proxy_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = crate::cache_root(app)?;
    let dir = root.join("proxy");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// The source's cache key — canonical path + size + mtime. Same key the
/// waveform, filmstrip and poster use, so replacing a file invalidates its
/// proxy exactly like it invalidates everything else.
fn source_key(path: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read that file: {e}"))?;
    crate::cache::source_key(path, &meta)
}

fn proxy_path(app: &tauri::AppHandle, path: &Path) -> Result<PathBuf, String> {
    Ok(proxy_dir(app)?.join(format!("{}.mp4", source_key(path)?)))
}

/// One proxy build at a time, process-wide.
///
/// Two FFmpeg encodes fighting for the same i3 is exactly the stall this app
/// avoids, and two builds of the *same* source would write the same temporary
/// file and hand the rename a corrupted MP4 — which the cache would then serve
/// forever, because it only asks `is_file()`.
fn build_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn parse_rate(text: &str) -> Option<f64> {
    let (num, den) = text.split_once('/')?;
    let num: f64 = num.parse().ok()?;
    let den: f64 = den.parse().ok()?;
    (den > 0.0 && num > 0.0).then(|| num / den)
}

/// PQ (HDR10) and HLG — the transfers a phone or a modern camera writes.
///
/// A proxy keeps the picture's *pixels*, so an HDR source must be tone mapped
/// on the way in or the preview shows a washed-out, grey version of the film
/// that matches neither the source nor the export.
fn is_hdr(transfer: &str) -> bool {
    matches!(transfer, "smpte2084" | "arib-std-b67")
}

/// `matroska,webm` covers two very different files. A real WebM (VP8/VP9) is
/// playable; an MKV holding H.264 is not, because Chromium only demuxes the
/// WebM subset. The codec decides, not the container name.
fn container_ok(container: &str, video: &str) -> bool {
    container
        .split(',')
        .map(str::trim)
        .any(|name| PLAYABLE_CONTAINERS.contains(&name))
        && !(container.contains("matroska") && video == "h264")
}

fn probe(path: &Path) -> Result<Source, String> {
    let raw = crate::ffmpeg::ffprobe_json(path)?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("ffprobe returned something unreadable: {e}"))?;

    let streams = doc
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    let video = streams.iter().find(|s| {
        s.get("codec_type").and_then(|c| c.as_str()) == Some("video")
            // An MP3/M4A/MKV can carry cover art as an `mjpeg` or `png` stream
            // with `attached_pic`. Treating that as "this file has a picture"
            // would burn a full-length encode of a still image instead of
            // taking the audio-only path.
            && s.get("disposition")
                .and_then(|d| d.get("attached_pic"))
                .and_then(|x| x.as_u64())
                != Some(1)
    });
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some("audio"));

    let text = |v: &serde_json::Value, key: &str| {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string()
    };

    let seconds = doc
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    Ok(Source {
        container: doc
            .get("format")
            .map(|f| text(f, "format_name"))
            .unwrap_or_default(),
        video: video.map(|v| text(v, "codec_name")).unwrap_or_default(),
        pix: video.map(|v| text(v, "pix_fmt")).unwrap_or_default(),
        transfer: video.map(|v| text(v, "color_transfer")).unwrap_or_default(),
        audio: audio.map(|a| text(a, "codec_name")),
        width: video
            .and_then(|v| v.get("width"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32,
        height: video
            .and_then(|v| v.get("height"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0) as u32,
        fps: video
            .and_then(|v| v.get("avg_frame_rate"))
            .and_then(|x| x.as_str())
            .and_then(parse_rate)
            .unwrap_or(0.0),
        has_video: video.is_some(),
        seconds,
    })
}

/* ----------------------------------------------------------------- plan */

/// Decide, from facts already probed, whether the preview can play the source.
fn decide(src: &Source, proxy: Option<String>) -> PreviewPlan {
    let build = |kind: &str, reason: String| PreviewPlan {
        kind: kind.to_string(),
        reason,
        proxy: proxy.clone(),
        seconds: src.seconds,
        has_video: src.has_video,
    };

    if !src.has_video {
        return build(
            "native",
            "Is file me picture nahi hai — audio-only project.".to_string(),
        );
    }

    let video_ok = PLAYABLE_VIDEO.contains(&src.video.as_str());
    let pix_ok = PLAYABLE_PIX.contains(&src.pix.as_str());
    let box_ok = container_ok(&src.container, &src.video);
    let hdr = is_hdr(&src.transfer);
    // A remux keeps every pixel, so a 4K source would still be 4K in the
    // preview — and decoding 4K in WebView2 on a low-power box is exactly the
    // stutter this app exists to avoid. Above 1080p it is a proxy, not a copy.
    let size_ok = src.width <= 1920 && src.height <= 1080;
    let audio_ok = match src.audio.as_deref() {
        // No audio track at all is fine.
        None | Some("") => true,
        Some(codec) => PLAYABLE_AUDIO.contains(&codec),
    };

    if video_ok && pix_ok && box_ok && !hdr && audio_ok {
        return build(
            "native",
            format!(
                "{} / {} — WebView2 ise seedha chala leta hai.",
                src.video, src.pix
            ),
        );
    }

    // The picture is already something Chromium decodes: only the wrapper (or
    // the sound) is wrong. `-c copy` keeps every frame bit-for-bit — seconds,
    // not minutes, and no generation loss.
    if video_ok && pix_ok && !hdr && size_ok {
        let mut why = Vec::new();
        if !box_ok {
            why.push(format!("{} container", src.container));
        }
        if !audio_ok {
            why.push(format!("{} audio", src.audio.clone().unwrap_or_default()));
        }
        return build(
            "remux",
            format!(
                "{} — picture copy hogi, sirf wrapper badlega.",
                why.join(" + ")
            ),
        );
    }

    let mut why = Vec::new();
    if !video_ok {
        why.push(format!("{} video", src.video));
    }
    if !pix_ok {
        why.push(format!("{} (10-bit / 4:2:2)", src.pix));
    }
    if hdr {
        why.push("HDR".to_string());
    }
    if !size_ok {
        why.push(format!("{}x{}", src.width, src.height));
    }
    if !box_ok {
        why.push(format!("{} container", src.container));
    }
    if !audio_ok {
        why.push(format!("{} audio", src.audio.clone().unwrap_or_default()));
    }
    build(
        "transcode",
        format!("{} — ek chhota H.264 proxy banega.", why.join(" + ")),
    )
}

/// Decide, from the file's own header, whether the preview can play it.
///
/// This is a header read — `ffprobe` never decodes the whole file — so it costs
/// the same on a 50 MB clip and a 5 GB episode.
fn plan_for(path: &Path, proxy: Option<String>) -> Result<PreviewPlan, String> {
    Ok(decide(&probe(path)?, proxy))
}

/* ---------------------------------------------------------------- encode */

/// HDR (PQ or HLG) → SDR, in linear light. Same chain `background_video.rs`
/// measured: average luma 126 (washed) → 119 (correct), tagged `bt709/bt709`.
const TONEMAP: &str = "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

/// One encoder the machine can actually run, with the flags that encoder
/// understands. `-crf` is libx264's; QSV and NVENC spell quality differently,
/// and passing the wrong one is a hard failure, not a warning.
struct Encoder {
    name: &'static str,
    args: Vec<String>,
}

impl Encoder {
    /// Every encoder this machine can use, best first, always ending in
    /// libx264 so a GPU that reports support but refuses a 10-bit source still
    /// produces a proxy instead of an error.
    fn chain() -> Vec<Encoder> {
        let mut out = Vec::new();
        // 26 is visually transparent for a preview at 720p and keeps the file
        // near 1 MB per 10 s — a 45-minute episode lands around 250-350 MB.
        if crate::ffmpeg::ffmpeg_encoder_usable("h264_qsv") {
            out.push(Encoder {
                name: "h264_qsv",
                args: ["-global_quality", "26", "-preset", "veryfast"]
                    .map(String::from)
                    .to_vec(),
            });
        }
        if crate::ffmpeg::ffmpeg_encoder_usable("h264_nvenc") {
            out.push(Encoder {
                name: "h264_nvenc",
                args: ["-cq", "26", "-preset", "p4"].map(String::from).to_vec(),
            });
        }
        if crate::ffmpeg::ffmpeg_encoder_usable("h264_amf") {
            out.push(Encoder {
                name: "h264_amf",
                args: ["-qp_i", "26", "-qp_p", "26", "-quality", "speed"]
                    .map(String::from)
                    .to_vec(),
            });
        }
        out.push(Encoder {
            name: "libx264",
            args: ["-crf", "26", "-preset", "veryfast"]
                .map(String::from)
                .to_vec(),
        });
        out
    }
}

fn emit(app: &tauri::AppHandle, pct: f64, stage: &'static str) {
    let _ = app.emit(
        "preview:progress",
        Progress {
            pct: pct.clamp(0.0, 100.0),
            stage,
        },
    );
}

/// The `-vf` chain: optional tone map, then a box that fits inside the proxy
/// frame without stretching. Literal numbers where possible — an ffmpeg
/// expression is a quoting hazard and a comma away from being two filters.
fn video_filter(src: &Source) -> String {
    let w = src.width.min(PROXY_W).max(2);
    let h = src.height.min(PROXY_H).max(2);
    let scale =
        format!("scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1");
    if is_hdr(&src.transfer) {
        format!("{TONEMAP},{scale}")
    } else {
        scale
    }
}

/// Same frames, new container — no decoder, no encoder, no generation loss.
fn remux(
    app: &tauri::AppHandle,
    src: &Path,
    dst: &Path,
    audio_copy: bool,
    total: f64,
) -> Result<(), String> {
    let source = src.to_string_lossy().into_owned();
    let target = dst.to_string_lossy().into_owned();
    let audio = if audio_copy { "copy" } else { "aac" };

    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        source,
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a:0?".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        audio.into(),
    ];
    if !audio_copy {
        args.extend(
            ["-b:a", "128k", "-ac", "2", "-ar", "48000"]
                .map(String::from)
                .to_vec(),
        );
    }
    args.extend(
        [
            "-sn",
            "-dn",
            "-movflags",
            "+faststart",
            // A copy of a 3.5 GB episode takes minutes, not seconds — the bar
            // has to move, or the stage looks frozen for the whole copy.
            "-progress",
            "pipe:1",
            "-nostats",
            &target,
        ]
        .map(String::from)
        .to_vec(),
    );

    let mut last = -10.0_f64;
    let handle = app.clone();
    let out = crate::ffmpeg::run_streaming("ffmpeg", &args, Some(cancel_flag()), |line| {
        let micros = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))
            .and_then(|v| v.trim().parse::<f64>().ok());
        if let Some(us) = micros {
            let pct = us / 1_000_000.0 / total.max(1.0) * 100.0;
            if pct - last >= 1.0 {
                last = pct;
                emit(&handle, pct, "remux");
            }
        }
    })?;
    if out.cancelled {
        let _ = std::fs::remove_file(dst);
        return Err("cancelled".to_string());
    }
    if out.success() && dst.is_file() {
        return Ok(());
    }
    let _ = std::fs::remove_file(dst);
    Err(format!(
        "could not repackage that video: {}",
        out.stderr_tail
            .trim()
            .lines()
            .last()
            .unwrap_or("ffmpeg refused it")
    ))
}

fn transcode(app: &tauri::AppHandle, src: &Path, dst: &Path, media: &Source) -> Result<(), String> {
    let vf = video_filter(media);
    let total = media.seconds.max(1.0);
    let flag = cancel_flag();
    let mut failure = String::new();

    for encoder in Encoder::chain() {
        flag.store(false, Ordering::SeqCst);
        let _ = std::fs::remove_file(dst);
        emit(app, 0.0, "convert");

        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-nostdin".into(),
            "-y".into(),
            "-i".into(),
            src.to_string_lossy().into_owned(),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "0:a:0?".into(),
            "-vf".into(),
            vf.clone(),
            "-c:v".into(),
            encoder.name.into(),
        ];
        args.extend(encoder.args.clone());
        args.extend(
            [
                "-profile:v",
                "high",
                "-pix_fmt",
                "yuv420p",
                // A short GOP is what makes scrubbing feel instant: with the
                // x264 default (~10 s) every seek lands on a keyframe far away
                // and the preview shows the wrong moment for a beat.
                "-g",
                "48",
                "-keyint_min",
                "48",
                "-sc_threshold",
                "0",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-ac",
                "2",
                "-ar",
                "48000",
                "-sn",
                "-dn",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
            ]
            .map(String::from)
            .to_vec(),
        );
        if media.fps > 31.0 {
            args.extend(["-r", "30"].map(String::from).to_vec());
        }
        args.push(dst.to_string_lossy().into_owned());

        let mut last = -10.0_f64;
        let handle = app.clone();
        let out = crate::ffmpeg::run_streaming("ffmpeg", &args, Some(Arc::clone(&flag)), |line| {
            let micros = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
                .and_then(|v| v.trim().parse::<f64>().ok());
            if let Some(us) = micros {
                let pct = us / 1_000_000.0 / total * 100.0;
                if pct - last >= 1.0 {
                    last = pct;
                    emit(&handle, pct, "convert");
                }
            }
        })?;

        if out.cancelled {
            let _ = std::fs::remove_file(dst);
            return Err("cancelled".to_string());
        }
        if out.success() && dst.is_file() {
            return Ok(());
        }
        failure = out
            .stderr_tail
            .trim()
            .lines()
            .last()
            .unwrap_or("ffmpeg refused the file")
            .to_string();
        crate::ffmpeg::log_line(&format!(
            "preview proxy: {} failed, trying the next encoder",
            encoder.name
        ));
    }

    Err(format!("preview proxy could not be built: {failure}"))
}

/* -------------------------------------------------------------- commands */

/// What the preview should play for this source, and why.
#[tauri::command]
pub fn preview_plan(app: tauri::AppHandle, path: String) -> Result<PreviewPlan, String> {
    let source = PathBuf::from(&path);
    if !source.is_file() {
        return Err("that file is not there any more".to_string());
    }
    let cached = proxy_path(&app, &source)
        .ok()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    plan_for(&source, cached)
}

/// Build the proxy if the plan calls for one, and hand back its path.
///
/// Idempotent: an existing proxy for the same key is returned without starting
/// FFmpeg, so reopening a project never re-encodes anything.
#[tauri::command]
pub async fn build_preview_proxy(app: tauri::AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || build_blocking(&app, &path))
        .await
        .map_err(|e| format!("preview proxy task failed: {e}"))?
}

fn build_blocking(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    let source = PathBuf::from(path);
    if !source.is_file() {
        return Err("that file is not there any more".to_string());
    }

    let target = proxy_path(app, &source)?;
    // Cached? Then nothing to do — checked again under the lock below, because
    // another build may have finished while this one waited.
    if target.is_file() {
        return Ok(target.to_string_lossy().into_owned());
    }

    let _guard = build_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if target.is_file() {
        return Ok(target.to_string_lossy().into_owned());
    }

    let media = probe(&source)?;
    let plan = decide(&media, None);

    if plan.kind == "native" {
        // Nothing to build — the caller should keep the source's own URL.
        return Ok(source.to_string_lossy().into_owned());
    }

    // The cancel flag is process-wide and survives the job that set it. Clear
    // it here, before either path, or the first remux after any cancelled
    // build would be killed the instant FFmpeg starts.
    cancel_flag().store(false, Ordering::SeqCst);

    // Written under a temporary name and renamed only when FFmpeg exits 0.
    //
    // A crash, a Task Manager kill or a cancel at the wrong moment otherwise
    // leaves a truncated MP4 behind, and `is_file()` above would happily serve
    // it forever: the preview would show a black frame with a bogus duration
    // and no error, on every open, with no way for the user to tell why.
    let tmp = target.with_extension("part.mp4");
    let _ = std::fs::remove_file(&tmp);

    let built = if plan.kind == "remux" {
        emit(app, 0.0, "remux");
        let audio_copy = media
            .audio
            .as_deref()
            .map(|a| PLAYABLE_AUDIO.contains(&a))
            .unwrap_or(true);
        remux(app, &source, &tmp, audio_copy, media.seconds)
    } else {
        transcode(app, &source, &tmp, &media)
    };

    if let Err(e) = built {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        return Err("the preview proxy was not written".to_string());
    }

    std::fs::rename(&tmp, &target)
        .map_err(|e| format!("could not store the preview proxy: {e}"))?;
    emit(app, 100.0, "done");
    Ok(target.to_string_lossy().into_owned())
}

/// Stop a proxy that is still encoding (mode switch, another file opened).
#[tauri::command]
pub fn cancel_preview_proxy() {
    cancel_flag().store(true, Ordering::SeqCst);
}

/// Forget one source's proxy — used when its file changes on disk.
#[tauri::command]
pub fn clear_preview_proxy(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    let source = PathBuf::from(&path);
    let target = proxy_path(&app, &source)?;
    Ok(std::fs::remove_file(target).is_ok())
}

/// Every proxy on disk, so the dashboard can show what the cache costs.
pub fn proxy_bytes(app: &tauri::AppHandle) -> u64 {
    let Ok(dir) = proxy_dir(app) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Used by the app's own settings screen: how many proxies are cached.
pub fn proxy_count(app: &tauri::AppHandle) -> usize {
    let Ok(dir) = proxy_dir(app) else {
        return 0;
    };
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|x| x == "mp4"))
                .count()
        })
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_in_mp4_is_native() {
        assert!(container_ok("mov,mp4,m4a,3gp,3g2,mj2", "h264"));
        assert!(PLAYABLE_PIX.contains(&"yuv420p"));
    }

    #[test]
    fn mkv_is_never_native_even_with_h264() {
        // `matroska,webm` is what ffprobe reports for both. A real WebM holds
        // VP8/VP9 and plays; an MKV holding H.264 does not.
        assert!(!container_ok("matroska,webm", "h264"));
        assert!(container_ok("matroska,webm", "vp9"));
    }

    #[test]
    fn mov_is_not_native_because_the_mime_is_quicktime() {
        assert!(!container_ok("mov", "h264"));
    }

    #[test]
    fn ten_bit_h264_is_not_playable() {
        assert!(!PLAYABLE_PIX.contains(&"yuv420p10le"));
    }

    #[test]
    fn hdr_needs_a_tone_map() {
        assert!(is_hdr("smpte2084"));
        assert!(is_hdr("arib-std-b67"));
        assert!(!is_hdr("bt709"));
        assert!(!is_hdr("unknown"));
    }

    #[test]
    fn bluray_audio_is_not_playable() {
        for codec in ["ac3", "eac3", "dts", "truehd"] {
            assert!(!PLAYABLE_AUDIO.contains(&codec), "{codec} must transcode");
        }
        assert!(PLAYABLE_AUDIO.contains(&"aac"));
    }

    #[test]
    fn proxy_box_never_upscales() {
        let src = Source {
            container: "matroska,webm".into(),
            video: "hevc".into(),
            pix: "yuv420p10le".into(),
            transfer: "unknown".into(),
            audio: Some("eac3".into()),
            width: 1920,
            height: 1080,
            fps: 23.976,
            seconds: 2643.0,
            has_video: true,
        };
        let vf = video_filter(&src);
        assert!(vf.contains("scale=720:720"), "{vf}");
        assert!(!vf.contains("tonemap"), "SDR must not be tone mapped");

        let small = Source {
            width: 640,
            height: 360,
            ..src
        };
        assert!(video_filter(&small).contains("scale=640:360"));
    }

    /// A plain 1080p H.264 file that Chromium would decode perfectly — only
    /// the container and the sound are wrong.
    fn h264_1080p_mkv() -> Source {
        Source {
            container: "matroska,webm".into(),
            video: "h264".into(),
            pix: "yuv420p".into(),
            transfer: "bt709".into(),
            audio: Some("dts".into()),
            width: 1920,
            height: 1080,
            fps: 23.976,
            seconds: 2643.0,
            has_video: true,
        }
    }

    #[test]
    fn a_1080p_h264_mkv_is_only_repackaged() {
        // The whole point of the remux path: a 3.5 GB episode must not pay for
        // a re-encode when the picture is already playable.
        let plan = decide(&h264_1080p_mkv(), None);
        assert_eq!(plan.kind, "remux", "{}", plan.reason);
        assert!(plan.reason.contains("dts"), "{}", plan.reason);
    }

    #[test]
    fn a_4k_h264_file_is_a_proxy_not_a_copy() {
        // A remux keeps every pixel, so 4K stays 4K and WebView2 has to decode
        // it — the stutter this app exists to avoid.
        let four_k = Source {
            width: 3840,
            height: 2160,
            ..h264_1080p_mkv()
        };
        let plan = decide(&four_k, None);
        assert_eq!(plan.kind, "transcode", "{}", plan.reason);
        assert!(plan.reason.contains("3840x2160"), "{}", plan.reason);
    }

    #[test]
    fn ten_bit_hevc_needs_a_full_proxy() {
        let hevc = Source {
            video: "hevc".into(),
            pix: "yuv420p10le".into(),
            audio: Some("eac3".into()),
            ..h264_1080p_mkv()
        };
        let plan = decide(&hevc, None);
        assert_eq!(plan.kind, "transcode");
        assert!(plan.reason.contains("hevc"), "{}", plan.reason);
        assert!(plan.reason.contains("10-bit"), "{}", plan.reason);
    }

    #[test]
    fn an_audio_only_file_is_left_alone() {
        let audio = Source {
            video: String::new(),
            pix: String::new(),
            audio: Some("aac".into()),
            width: 0,
            height: 0,
            has_video: false,
            ..h264_1080p_mkv()
        };
        assert_eq!(decide(&audio, None).kind, "native");
    }

    #[test]
    fn a_cached_proxy_is_reported_with_the_plan() {
        let plan = decide(
            &Source {
                video: "hevc".into(),
                pix: "yuv420p10le".into(),
                ..h264_1080p_mkv()
            },
            Some("C:/cache/proxy/abc.mp4".into()),
        );
        assert_eq!(plan.kind, "transcode");
        assert_eq!(plan.proxy.as_deref(), Some("C:/cache/proxy/abc.mp4"));
    }

    #[test]
    fn a_playable_mp4_is_native_and_needs_no_proxy() {
        let mp4 = Source {
            container: "mov,mp4,m4a,3gp,3g2,mj2".into(),
            audio: Some("aac".into()),
            ..h264_1080p_mkv()
        };
        let plan = decide(&mp4, None);
        assert_eq!(plan.kind, "native", "{}", plan.reason);
        assert!(plan.proxy.is_none());
    }
}
