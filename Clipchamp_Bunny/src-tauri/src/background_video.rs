//! Where the background video lives on disk.
//!
//! The interface plays `leatTokyo.mp4` behind the UI. The rule for that video
//! is that it is **never buffered into memory**: the webview streams it through
//! Tauri's `asset://` protocol, which answers HTTP `Range` requests by seeking
//! in the file and reading only the bytes asked for. This module's whole job is
//! therefore to hand the frontend a path that actually exists — the bytes never
//! travel through a command payload.
//!
//! Candidates, in order:
//!
//!   1. the repository / installer copies — `resource_Clipchamp/leatTokyo.mp4`
//!      four folder-climbs above the executable (the `tauri dev` and local
//!      build case), the same file relative to the working directory, and the
//!      packaged `resource_dir`;
//!   2. a copy sitting next to the executable;
//!   3. the video embedded in the frontend bundle (`public/assets/…`), written
//!      out **once** to `<app_local_data>/assets/…` on the first run.
//!
//! Step 3 is what makes a packaged build self-sufficient: the deploy pipeline
//! installs the executable alone, so nothing else can place the file beside it.
//! The frontend assets are the only copy that travels with the binary, and the
//! extraction happens once per machine — afterwards the same path is found
//! again before any of the search runs.

use std::path::{Path, PathBuf};
use tauri::Manager;

/// The file itself.
const BG_NAME: &str = "leatTokyo.mp4";
/// Home of the master copy in the repository.
const BG_REPO: &str = "resource_Clipchamp/leatTokyo.mp4";
/// The same file inside the bundled frontend (`public/assets/…` → `dist/…`).
const BG_ASSET: &str = "assets/leatTokyo.mp4";

/// A path only counts when it is a real file; the string form is what the
/// frontend passes to `convertFileSrc`.
fn file(path: &Path) -> Option<String> {
    path.is_file()
        .then(|| path.to_string_lossy().into_owned())
}

/// Every place the video might already be, cheapest answer first for a
/// *packaged* install (nothing on disk matches until the extracted copy).
fn candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // The repository copy: four climbs from `target/{debug,release}` reach the
    // repository root, which is where `resource_Clipchamp/` lives.
    if let Some(exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
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

    // The working directory — a plain `cargo run` starts in `Clipchamp_Bunny`,
    // whose parent is the repository root.
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join(BG_REPO));
        out.push(cwd.join("assets").join(BG_NAME));
        if let Some(parent) = cwd.parent() {
            out.push(parent.join(BG_REPO));
        }
    }

    // The packaged resource folder (an installer build ships it as a resource).
    if let Ok(dir) = app.path().resource_dir() {
        out.push(dir.join(BG_REPO));
        out.push(dir.join(BG_NAME));
        out.push(dir.join("assets").join(BG_NAME));
    }

    // The copy an earlier run extracted from the embedded frontend.
    if let Ok(dir) = app.path().app_local_data_dir() {
        out.push(dir.join("assets").join(BG_NAME));
    }

    out
}

/// Write the embedded copy out once, so it can be range-requested from disk.
///
/// `AssetResolver::get` is the only way to read a bundled asset from Rust, and
/// it returns the whole file — a 10 MB read that happens a single time per
/// machine, after which the path is reused and nothing is read again. The
/// webview never sees those bytes; it streams the file that lands here.
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

/// The path the background `<video>` should stream from, or `None` when the
/// file cannot be found anywhere — the frontend then falls back to its static
/// background instead of showing an empty rectangle.
pub fn resolve(app: &tauri::AppHandle) -> Option<String> {
    candidates(app).iter().find_map(|c| file(c)).or_else(|| extract(app))
}

/// Frontend entry point: path only, never bytes.
#[tauri::command]
pub fn background_video_path(app: tauri::AppHandle) -> Option<String> {
    resolve(&app)
}
