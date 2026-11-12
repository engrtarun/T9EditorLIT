//! The in-built browser's native half: one WebView2 child per tab.
//!
//! The memory budget is structural rather than policed. The webview
//! **ledger** is: the active tab plus at most one kept tab (the one the
//! user just left) — never more than two children. Earlier tabs are
//! destroyed on every switch. Kept webviews are collapsed to 1×1 logical
//! pixels (rendering cost ≈ 0, page state intact), so a back-switch shows
//! the previous page *instantly* — no reload — and z-order can never put a
//! stale page above the active one. An empty tab costs zero bytes: no
//! webview exists until a real URL is navigated to, which is also why the
//! speed dial renders in the main webview's DOM.
//!
//! The cost is honest and documented: any tab beyond the most recent two
//! loses its in-page state and reloads when re-selected — the trade every
//! mobile browser already makes. The benefit is that "≤500 MB while
//! browsing" needs no watchdog: there is nothing to evict because there
//! are never more than two webviews, and the second is inert (1×1).
//! The cost of that rule is honest and documented: a background tab loses
//! its in-page state (scroll position, unsaved form input) and reloads when
//! re-selected — the trade every mobile browser already makes. The benefit
//! is that "≤500 MB with nine tabs" needs no watchdog, no OOM sampling and
//! no LRU heuristic: there is nothing to evict because there is never more
//! than one webview.
//!
//! The tab *list* lives in the Svelte store (it owns the strip, the cap and
//! the history stack); this module owns only the webviews and reports back
//! through three events:
//!
//!   · `browser:page`      — a page finished loading  { id, url }
//!   · `browser:nav`       — the page navigated itself (link click,
//!                           redirect)                        { id, url }
//!   · `browser:download`  — WebView2 would have downloaded a file; the
//!                           handler cancels it and the frontend hands the
//!                           URL to the Go daemon's multi-segment
//!                           downloader instead        { url, referer }

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::{
    DownloadEvent, NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder,
};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl, Window,
};

/// Append one line to the browser diagnostic log (`%LOCALAPPDATA%\T9EditorLIT\browser-diag.log`).
///
/// Every browser command, webview event and failure lands here so that
/// "page does not render" can be told apart from "webview never created"
/// from a file read — without a new build. Best-effort: a logging problem
/// must never break the command.
pub(crate) fn diag(msg: &str) {
    let Some(path) = std::env::var_os("LOCALAPPDATA").map(|root| {
        std::path::PathBuf::from(root)
            .join("T9EditorLIT")
            .join("browser-diag.log")
    }) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{ts}] {msg}");
}

/// Hosts that exist only to serve ads or count users.
///
/// uBlock Origin Lite is the primary blocker, but its Basic mode (no host
/// permission) grants it DNR rules and no site access, and the
/// extensions-off fallback has no blocker at all. Neither state is visible
/// in the UI, so the browser refuses the worst offenders itself.
///
/// Deliberately no `googlevideo.com` and no `ytimg.com`: the ad stream and
/// the real stream arrive from the same CDNs, so a host block there would
/// break playback instead of ads. YouTube's in-stream ads are handled by the
/// player-response prune in `browser_shim.js`.
const AD_HOSTS: &[&str] = &[
    "2mdn.net",
    "adform.net",
    "adnxs.com",
    "adsrvr.org",
    "amazon-adsystem.com",
    "casalemedia.com",
    "criteo.com",
    "criteo.net",
    "doubleclick.net",
    "google-analytics.com",
    "googleadservices.com",
    "googlesyndication.com",
    "googletagmanager.com",
    "moatads.com",
    "openx.net",
    "outbrain.com",
    "pubmatic.com",
    "quantserve.com",
    "rubiconproject.com",
    "scorecardresearch.com",
    "serving-sys.com",
    "smartadserver.com",
    "taboola.com",
    "teads.tv",
    "zedo.com",
];

/// YouTube's own ad endpoints: they serve an ad click, count an ad view, or
/// report ad playback. None of them is on the video playback path.
const AD_PATHS: &[&str] = &["/pagead/", "/ptracking", "/api/stats/ads"];

/// Requests refused by the native ad shield since launch — diag proof that
/// the shield is doing something, not a counter the UI has to hold.
static AD_BLOCKED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Is this URL one the browser refuses on its own?
///
/// Host-suffix match on the authority (so `ads.doubleclick.net` matches and
/// `notdoubleclick.net` does not), plus YouTube's ad endpoints. Pure, so the
/// rule is unit-tested without a webview.
fn ad_request(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let Some(scheme_end) = lower.find("://") else {
        return false;
    };
    let rest = &lower[scheme_end + 3..];
    let host_end = rest.find(['/', ':', '?', '#']).unwrap_or(rest.len());
    let host = &rest[..host_end];

    if (host == "youtube.com" || host.ends_with(".youtube.com"))
        && AD_PATHS.iter().any(|path| rest[host_end..].starts_with(path))
    {
        return true;
    }

    AD_HOSTS.iter().any(|blocked| {
        host == *blocked
            || (host.len() > blocked.len()
                && host.ends_with(*blocked)
                && host.as_bytes()[host.len() - blocked.len() - 1] == b'.')
    })
}

/// One UTF-16, NUL-terminated buffer for the Win32 string parameters.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A page or self-navigation report. Mirrors what the store needs to update
/// one tab row (`camelCase` over the wire).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavPayload {
    pub id: String,
    pub url: String,
}

/// The page's own `<title>` (document title changed). The strip and the
/// downloads panel show it instead of the hostname.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitlePayload {
    pub id: String,
    pub title: String,
}

/// A page entered or left the Fullscreen API (YouTube's ⛶ button). The
/// webview is grown to the whole window so "fullscreen" means the screen,
/// not the content rectangle.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullscreenPayload {
    pub id: String,
    pub on: bool,
}

/// A key combo the page webview sent through the document-start shim. The
/// action names are the same ones `src/lib/browser-keys.ts` resolves, so one
/// dep table in App.svelte serves both the DOM and the native path.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPayload {
    pub id: String,
    pub action: String,
    /// 0-based tab index, -1/+1 tab move, force-reload flag, or zoom direction.
    pub value: Option<i32>,
}

/// A message from `browser_shim.js`. `t9` is the marker that keeps a page's
/// own `postMessage` traffic from being mistaken for a browser command.
#[derive(serde::Deserialize)]
struct ShimMessage {
    t9: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    value: Option<i32>,
}

/// The document-start script: new-window links → `browser:popup`, Firefox
/// keys → `browser:key`. Compiled into the binary, so it can never drift from
/// the build that ships it.
const SHIM: &str = include_str!("browser_shim.js");

/// A file WebView2 wanted to download. The referer is the tab's current URL:
/// some hosts refuse a download that arrives with no referrer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPayload {
    pub url: String,
    pub referer: Option<String>,
}

/// The content rectangle (logical pixels, relative to the window's client
/// area) the active tab's webview must cover.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ContentRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Managed state: the rectangle the frontend measured for the browser's
/// content area (`[data-focus="browser-content"]`), and the label of the
/// webview currently showing there (kept webviews are collapsed and must
/// not be resized back to full by rect updates).
pub struct BrowserState {
    rect: Mutex<ContentRect>,
    active: Mutex<String>,
    /// Tabs the user pinned: their webview is never destroyed while another
    /// tab is active, so audio and page state keep running (Firefox's pinned
    /// tab, which is what "listen to YouTube for hours" actually needs).
    /// Session-only: a restart starts with no pins.
    pinned: Mutex<HashSet<String>>,
    /// Tab labels whose page is in the Fullscreen API right now. While one is
    /// set, its webview covers the whole window, so a later "show the page"
    /// (an overlay closing) has to restore *that* box, not the content rect.
    fullscreen: Mutex<HashSet<String>>,
    /// An overlay is covering the content rect and the active page is parked.
    /// Rect updates still arrive (the window can be resized behind a modal);
    /// none of them may un-park the page or the overlay loses its lower half.
    parked: AtomicBool,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            rect: Mutex::new(ContentRect::default()),
            active: Mutex::new(String::new()),
            pinned: Mutex::new(HashSet::new()),
            fullscreen: Mutex::new(HashSet::new()),
            parked: AtomicBool::new(false),
        }
    }
}

/// Read the pinned set without letting a poisoned lock break a command.
fn pinned_ids<R: Runtime>(app: &tauri::AppHandle<R>) -> HashSet<String> {
    app.state::<BrowserState>()
        .pinned
        .lock()
        .map(|set| set.clone())
        .unwrap_or_default()
}

fn set_active<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let state = app.state::<BrowserState>();
    if let Ok(mut a) = state.active.lock() {
        *a = label.to_string();
    }
}

/// The webview label for a tab id. The `tab-` prefix keeps child labels
/// from ever colliding with the main window's own name.
pub(crate) fn label_for(id: &str) -> String {
    format!("tab-{id}")
}

/// Set once WebView2 has refused an extensions-enabled environment. Every
/// later tab is then built without extensions instead of paying the exact
/// same failure again; the UI is told the truth through `browser:extensions`.
static EXTENSIONS_OFF: AtomicBool = AtomicBool::new(false);

/// Per-tab WebView2 switches. `additional_browser_args` replaces wry's
/// defaults, so the three protective switches are repeated verbatim and the
/// autoplay switch keeps wry's default (`autoplay: true`) intact.
///
/// `MediaSessionService` is the important addition: it is Chromium's own
/// media-session service. While it runs, every tab owns a session belonging
/// to `msedgewebview2.exe` — "Unknown app" in the Windows flyout — and the
/// earbud's next/previous keys go to that session instead of ours. With it
/// off, `smtc.rs` is the only session this app has, and every button has one
/// owner. `HardwareMediaKeyHandling` is the sibling flag: it is the browser
/// process itself grabbing the media keys, which would survive a disabled
/// session service and swallow the earbud press before Windows routes it.
///
/// `CalculateNativeWinOcclusion` is what made some sites (YouTube was the
/// one that reproduced) come up as a permanent skeleton: Chromium decides a
/// window is "occluded" from Win32 z-order, marks the page hidden, and
/// throttles its timers/rAF. A WebView2 child inside a Tauri window is easy
/// to mis-classify, especially while the browser view mounts or another
/// window is in front — the page's lazy loader then never runs and the site
/// sits on its loading placeholders until a hard reload. This app never
/// wants occlusion throttling: a hidden page in it is either parked at 1×1
/// (pinned tabs, deliberately kept awake) or destroyed outright.
const TAB_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,MediaSessionService,HardwareMediaKeyHandling,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required";

/// The dedicated WebView2 profile for page webviews.
///
/// This is the fix for `HRESULT(0x8007139F)` (`ERROR_INVALID_STATE`) when a
/// tab was opened after uBlock arrived. WebView2 allows exactly one set of
/// environment options per user-data folder. The main window creates the
/// app's default environment with extensions **off**; a tab then asked for
/// the same folder with extensions **on**, which WebView2 rejects before a
/// single window is created.
///
/// Tabs now live in their own folder. That keeps the main UI environment
/// untouched, keeps every tab on identical options, and gives the browser
/// its own cookie/login jar that survives app restarts. (It also means a
/// `dataDirectory` change for the app shell can never invalidate open tabs.)
#[cfg(target_os = "windows")]
fn tabs_profile_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    let base = app.path().local_data_dir().ok()?;
    let dir = base.join("T9EditorLIT").join("browser-profile");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

#[cfg(not(target_os = "windows"))]
fn tabs_profile_dir<R: Runtime>(_app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    None
}

/// Where the Go daemon unpacks uBlock Origin Lite.
///
/// Both processes resolve this folder themselves — the daemon writes it, the
/// webview reads it — so neither has to ask the other before a tab opens.
/// `%LOCALAPPDATA%\T9EditorLIT\ublock\extensions-mv3` on Windows; the daemon's
/// `os.UserCacheDir()` lands on the same `%LOCALAPPDATA%`.
///
/// The `-mv3` suffix is deliberate: Chromium 139+ refuses Manifest V2
/// extensions, so the old `extensions/uBlock0.chromium` folder must never be
/// scanned again. A fresh path is the cleanest way to guarantee that.
///
/// `None` means "not unpacked yet" (first run, offline, or a failed update):
/// the webview is then created without extensions instead of pointing WebView2
/// at an empty folder and pretending.
#[cfg(target_os = "windows")]
fn extensions_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    let base = app.path().local_data_dir().ok()?;
    let dir = base.join("T9EditorLIT").join("ublock").join("extensions-mv3");
    if dir.join("uBOLite.chromium").join("manifest.json").is_file() {
        Some(dir)
    } else {
        None
    }
}

/// Tell WebView2 how much memory this webview is allowed to keep.
///
/// A collapsed tab (the one the user just left, parked at 1×1 px) keeps its
/// page state but never needs to be render-ready: `LOW` lets WebView2 drop
/// caches and trim its working set. The active tab gets `NORMAL` back, so
/// scrolling does not pay for the trim. This is the part the "≤2 webviews"
/// cap cannot do on its own: it is the difference between a live background
/// page and an inert one.
#[cfg(target_os = "windows")]
fn set_memory_target<R: Runtime>(webview: &Webview<R>, low: bool) {
    let label = webview.label().to_string();
    let _ = webview.with_webview(move |pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
        };
        use windows::core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else {
            return;
        };
        let Ok(core19) = core.cast::<ICoreWebView2_19>() else {
            diag(&format!(
                "memory target {label} -> unavailable (WebView2 runtime too old)"
            ));
            return;
        };
        let level = if low {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
        } else {
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
        };
        if core19.SetMemoryUsageTargetLevel(level).is_ok() {
            diag(&format!(
                "memory target {label} -> {}",
                if low { "low" } else { "normal" }
            ));
        }
    });
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionsPayload {
    id: String,
    names: Vec<String>,
    enabled: Vec<bool>,
    error: Option<String>,
}

/// Ask WebView2 which extensions the profile really has.
///
/// Tauri's `extensions_path` is fire-and-forget: wry calls
/// `AddBrowserExtension` and ignores a failure. So "uBlock is on" is only a
/// claim until the profile answers. `GetBrowserExtensions` is that answer —
/// name + enabled flag from the browser itself, not from our folder listing.
#[cfg(target_os = "windows")]
fn extension_list<R: Runtime>(webview: &Webview<R>) -> Result<Vec<(String, bool)>, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2BrowserExtensionList, ICoreWebView2Profile7, ICoreWebView2_13,
    };
    use webview2_com::{take_pwstr, ProfileGetBrowserExtensionsCompletedHandler};
    use windows::core::{Interface, BOOL, PWSTR};

    let (tx, rx) = std::sync::mpsc::channel::<Result<Vec<(String, bool)>, String>>();

    let posted = webview.with_webview(move |pw| unsafe {
        let Ok(core) = pw.controller().CoreWebView2() else {
            let _ = tx.send(Err("CoreWebView2 unavailable".into()));
            return;
        };
        let Ok(profile) = core
            .cast::<ICoreWebView2_13>()
            .and_then(|c| c.Profile())
        else {
            let _ = tx.send(Err("profile unavailable".into()));
            return;
        };
        let Ok(profile7) = profile.cast::<ICoreWebView2Profile7>() else {
            let _ = tx.send(Err("ICoreWebView2Profile7 unavailable".into()));
            return;
        };

        let fail_tx = tx.clone();
        let handler = ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(
            move |_hr, list: Option<ICoreWebView2BrowserExtensionList>| {
                let Some(list) = list else {
                    let _ = tx.send(Err("browser extension list was null".into()));
                    return Ok(());
                };
                let mut count = 0u32;
                if list.Count(&mut count).is_err() {
                    let _ = tx.send(Err("extension count failed".into()));
                    return Ok(());
                }
                let mut out = Vec::with_capacity(count as usize);
                for i in 0..count {
                    let Ok(ext) = list.GetValueAtIndex(i) else {
                        continue;
                    };
                    let mut name = PWSTR::null();
                    let mut enabled = BOOL(0);
                    if ext.Name(&mut name).is_ok() && ext.IsEnabled(&mut enabled).is_ok() {
                        out.push((take_pwstr(name), enabled.as_bool()));
                    }
                }
                let _ = tx.send(Ok(out));
                Ok(())
            },
        ));
        if profile7.GetBrowserExtensions(&handler).is_err() {
            let _ = fail_tx.send(Err("GetBrowserExtensions failed".into()));
        }
    });
    if posted.is_err() {
        return Err("webview was not available to answer".into());
    }

    rx.recv_timeout(std::time::Duration::from_secs(4))
        .unwrap_or_else(|_| Err("WebView2 ne 4s me extension list nahi di".to_string()))
}

/// Report the profile's real extension list to the UI.
///
/// The wait happens on a worker thread: the completion handler runs on the
/// WebView2 thread, and blocking that thread is how a browser deadlocks.
#[cfg(target_os = "windows")]
fn report_extensions<R: Runtime>(app: &tauri::AppHandle<R>, webview: &Webview<R>, id: &str) {
    let app = app.clone();
    let id = id.to_string();

    if EXTENSIONS_OFF.load(Ordering::Relaxed) {
        let _ = app.emit(
            "browser:extensions",
            ExtensionsPayload {
                id,
                names: Vec::new(),
                enabled: Vec::new(),
                error: Some(
                    "WebView2 ne extensions-enabled profile reject kiya; ad blocker off hai"
                        .to_string(),
                ),
            },
        );
        return;
    }

    let webview = webview.clone();
    std::thread::spawn(move || {
        // `AddBrowserExtension` is asynchronous and wry does not await it, so
        // the very first query can race the install. Three tries (500 ms
        // apart) turn "unknown yet" into an answer instead of a false
        // "not loaded". A genuinely missing extension still reports after
        // the last try — the UI never gets a guess.
        let mut result = extension_list(&webview);
        for _ in 0..2 {
            let settled = matches!(&result, Ok(list) if !list.is_empty());
            if settled {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
            result = extension_list(&webview);
        }
        let (names, enabled, error) = match result {
            Ok(list) => {
                let names: Vec<String> = list.iter().map(|(n, _)| n.clone()).collect();
                let enabled: Vec<bool> = list.iter().map(|(_, e)| *e).collect();
                (names, enabled, None)
            }
            Err(err) => (Vec::new(), Vec::new(), Some(err)),
        };
        let _ = app.emit(
            "browser:extensions",
            ExtensionsPayload {
                id,
                names,
                enabled,
                error,
            },
        );
    });
}

#[cfg(not(target_os = "windows"))]
fn set_memory_target<R: Runtime>(_webview: &Webview<R>, _low: bool) {}

#[cfg(not(target_os = "windows"))]
fn report_extensions<R: Runtime>(_app: &tauri::AppHandle<R>, _webview: &Webview<R>, _id: &str) {}

#[cfg(not(target_os = "windows"))]
fn extensions_dir<R: Runtime>(_app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    None
}

/// Collapse a live but not-visible webview: 1×1 px, and optionally tell
/// WebView2 to trim.
///
/// Audio and timers keep running (the page is still "visible" to Chromium),
/// but it paints nothing and cannot sit above the active tab. `keep_awake`
/// is for pinned tabs: the user asked for that page to keep running, so it
/// is parked but never pushed to WebView2's LOW memory target — the renderer
/// stays fully awake for YouTube playback.
fn park_webview<R: Runtime>(webview: &Webview<R>, keep_awake: bool) {
    let _ = webview.set_size(LogicalSize::new(1.0, 1.0));
    set_memory_target(webview, !keep_awake);
}

/// Interpret one message from `browser_shim.js`.
///
/// The tab id comes from the webview closure, never from the payload: a page
/// can only act as the tab it is.
fn handle_shim_message<R: Runtime>(app: &tauri::AppHandle<R>, id: &str, raw: &str) {
    let Ok(msg) = serde_json::from_str::<ShimMessage>(raw) else {
        return;
    };
    match msg.t9.as_str() {
        "open" => {
            let Some(url) = msg.url else { return };
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return;
            }
            diag(&format!("event popup {id} -> {url}"));
            let _ = app.emit(
                "browser:popup",
                NavPayload {
                    id: id.to_string(),
                    url,
                },
            );
        }
        "key" => {
            let Some(action) = msg.action else { return };
            diag(&format!("event key {id} -> {action} {:?}", msg.value));
            let _ = app.emit(
                "browser:key",
                KeyPayload {
                    id: id.to_string(),
                    action,
                    value: msg.value,
                },
            );
        }
        // SPA navigation (YouTube's video-to-video clicks): the document URL
        // changed via history.pushState, so no `on_navigation` fired. The
        // store needs it, or the tab strip lies and a re-show thinks the page
        // is still on the old URL.
        "url" => {
            let Some(url) = msg.url else { return };
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return;
            }
            let _ = app.emit(
                "browser:spa",
                NavPayload {
                    id: id.to_string(),
                    url,
                },
            );
        }
        // Fullscreen (YouTube's ⛶, a video element going fullscreen). The
        // page's own fullscreen only fills the webview; the webview is a child
        // of this window, so it must be grown to the window for the result to
        // be a real fullscreen. On exit the content rect comes back.
        "fullscreen" => {
            let on = msg.value.unwrap_or(0) != 0;
            let Some(window) = app.get_window("main") else {
                return;
            };
            let Some(webview) = find_tab(&window, &label_for(id)) else {
                return;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window.inner_size().unwrap_or_default();
            let rect = app
                .state::<BrowserState>()
                .rect
                .lock()
                .map(|r| *r)
                .unwrap_or_default();
            let id_owned = id.to_string();
            // Remember which tabs are fullscreen: "show the page" (an overlay
            // closing) must restore the window-sized box, not the content rect.
            {
                let state = app.state::<BrowserState>();
                if let Ok(mut set) = state.fullscreen.lock() {
                    if on {
                        set.insert(label_for(id));
                    } else {
                        set.remove(&label_for(id));
                    }
                }
            }
            // Tell the UI first: it hides the chrome rows without re-laying
            // them out (a layout change would feed a new content rect back to
            // Rust in the middle of fullscreen).
            let _ = app.emit(
                "browser:fullscreen",
                FullscreenPayload {
                    id: id_owned.clone(),
                    on,
                },
            );
            // The webview handle must not be resized inside the WebMessage
            // handler: that handler already runs on the UI thread, and the
            // resize marshals back onto it. One short-lived worker keeps the
            // page and the window responsive.
            std::thread::spawn(move || {
                if on {
                    let _ = webview.set_position(LogicalPosition::new(0.0, 0.0));
                    let _ = webview.set_size(LogicalSize::new(
                        f64::from(size.width) / scale,
                        f64::from(size.height) / scale,
                    ));
                } else if rect.width >= 2.0 && rect.height >= 2.0 {
                    let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
                    let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
                }
                diag(&format!("event fullscreen {id_owned} -> {on}"));
            });
        }
        // Media state for the Windows flyout. Chromium's own media session is
        // switched off per tab (see `TAB_BROWSER_ARGS`), so this report is
        // what gives the session a title, an icon and working next/prev.
        "media" => {
            let Ok(report) = serde_json::from_str::<crate::smtc::MediaReport>(raw) else {
                return;
            };
            crate::smtc::update(app, id, report);
        }
        _ => {}
    }
}

/// Wire a freshly created page webview to the app: keyboard bridge, browser
/// accelerators off, notification permission, and a notification log line.
///
/// Safe to call only after `add_child` succeeded; every step is best-effort so
/// an older WebView2 runtime degrades to "no notifications"/"no shortcut
/// bridge" instead of losing the tab.
#[cfg(target_os = "windows")]
fn configure_tab_webview<R: Runtime>(app: &tauri::AppHandle<R>, webview: &Webview<R>, id: &str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs2, ICoreWebView2Profile3, ICoreWebView2Settings3,
        ICoreWebView2_13, ICoreWebView2_2, ICoreWebView2_24,
        COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS, COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
    };
    use webview2_com::{
        take_pwstr, NotificationReceivedEventHandler, PermissionRequestedEventHandler,
        WebMessageReceivedEventHandler, WebResourceRequestedEventHandler,
    };
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::System::Com::IStream;

    let label = webview.label().to_string();
    let msg_app = app.clone();
    let msg_id = id.to_string();
    let note_id = id.to_string();
    // Alt+F4 has to leave the app even while this page owns the keyboard
    // focus; the handler is registered on every tab, not just the shell.
    let close_app = app.clone();

    let posted = webview.with_webview(move |pw| unsafe {
        // `controller()` hands back an owned COM reference on this Tauri
        // version, so it is bound once and borrowed for the registration.
        let controller = pw.controller();
        attach_exit_accelerator(&close_app, &controller);
        let Ok(core) = pw.controller().CoreWebView2() else {
            diag("configure -> CoreWebView2 unavailable");
            return;
        };

        // WebView2's own Ctrl+F / Ctrl+R / Ctrl+P / F5 would fire before the
        // page sees the key, which is why the shim never received them.
        if let Ok(settings) = core.Settings() {
            if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                match s3.SetAreBrowserAcceleratorKeysEnabled(false) {
                    Ok(()) => diag(&format!("accelerators {label} -> off")),
                    Err(err) => diag(&format!("accelerators {label} ERR {err}")),
                }
            }
        }

        // Balanced tracking prevention is the layer *under* the extension:
        // uBOL does the fine-grained blocking, and WebView2 still refuses the
        // trackers Chromium already knows. STRICT was the bug behind "site
        // load hi nahi hoti": it blocks third-party scripts and storage that
        // real pages need for login, video, comments and checkout (YouTube's
        // consent/player bootstrap was the one that reproduced). BALANCED is
        // Chromium's default and still blocks known cross-site trackers.
        if let Ok(profile) = core.cast::<ICoreWebView2_13>().and_then(|c| c.Profile()) {
            if let Ok(profile3) = profile.cast::<ICoreWebView2Profile3>() {
                match profile3.SetPreferredTrackingPreventionLevel(
                    COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_BALANCED,
                ) {
                    Ok(()) => diag(&format!("tracking {label} -> balanced")),
                    Err(err) => diag(&format!("tracking {label} ERR {err}")),
                }
            }
        }

        // The native ad shield. uBOL does the fine-grained work; this is the
        // net under it for the two states the extension cannot cover (Basic
        // mode, extensions-off fallback). Only ad-only hosts are filtered, so
        // an ordinary request never reaches the handler.
        for host in AD_HOSTS {
            for scheme in ["https", "http"] {
                let pattern = wide(&format!("{scheme}://*.{host}/*"));
                let _ = core.AddWebResourceRequestedFilter(
                    PCWSTR::from_raw(pattern.as_ptr()),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                );
            }
        }
        for path in AD_PATHS {
            let pattern = wide(&format!("https://*.youtube.com{path}*"));
            let _ = core.AddWebResourceRequestedFilter(
                PCWSTR::from_raw(pattern.as_ptr()),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            );
        }

        let environment = core
            .cast::<ICoreWebView2_2>()
            .ok()
            .and_then(|c| c.Environment().ok());
        let mut shield_token = 0i64;
        let shield = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let Ok(request) = args.Request() else {
                return Ok(());
            };
            let mut raw = PWSTR::null();
            if request.Uri(&mut raw).is_err() {
                return Ok(());
            }
            let url = take_pwstr(raw);
            if !ad_request(&url) {
                return Ok(());
            }
            if let Some(env) = &environment {
                // A 403 with no body is what a blocker has always looked
                // like: the request fails fast and the page's own fallback
                // runs. Returning nothing would leave the request pending.
                let reason = wide("Blocked");
                let headers = wide("Content-Type: text/plain");
                if let Ok(response) = env.CreateWebResourceResponse(
                    None::<&IStream>,
                    403,
                    PCWSTR::from_raw(reason.as_ptr()),
                    PCWSTR::from_raw(headers.as_ptr()),
                ) {
                    let _ = args.SetResponse(&response);
                }
            }
            let n = AD_BLOCKED.fetch_add(1, Ordering::Relaxed) + 1;
            if n == 1 || n % 50 == 0 {
                let shown: String = url.chars().take(120).collect();
                diag(&format!("ad shield -> {n} blocked (last: {shown})"));
            }
            Ok(())
        }));
        if core
            .add_WebResourceRequested(&shield, &mut shield_token)
            .is_err()
        {
            diag(&format!("ad shield {label} ERR"));
        }

        // The page -> Rust bridge behind new-window links and browser keys.
        let mut bridge_token = 0i64;
        let bridge = WebMessageReceivedEventHandler::create(Box::new(move |_sender, args| {
            if let Some(args) = args {
                let mut raw = PWSTR::null();
                if args.TryGetWebMessageAsString(&mut raw).is_ok() {
                    handle_shim_message(&msg_app, &msg_id, &take_pwstr(raw));
                }
            }
            Ok(())
        }));
        if core
            .add_WebMessageReceived(&bridge, &mut bridge_token)
            .is_err()
        {
            diag(&format!("shim bridge {label} ERR"));
        }

        // Site notifications (YouTube's bell, web chat). The browser has one
        // user and no second profile, so the permission prompt is noise:
        // grant it. WebView2 then paints the native Windows toast.
        let mut perm_token = 0i64;
        let perm = PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                if args.PermissionKind(&mut kind).is_ok()
                    && kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS
                {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    // `Handled` lives on the _2 interface; the base one only
                    // carries State. Marking it handled suppresses WebView2's
                    // own prompt, which a single-user browser does not need.
                    if let Ok(args2) = args.cast::<ICoreWebView2PermissionRequestedEventArgs2>() {
                        let _ = args2.SetHandled(true);
                    }
                }
            }
            Ok(())
        }));
        let _ = core.add_PermissionRequested(&perm, &mut perm_token);

        // Handled stays FALSE on purpose: that is what makes WebView2 show its
        // default notification UI. This handler only writes the diag proof.
        if let Ok(core24) = core.cast::<ICoreWebView2_24>() {
            let mut note_token = 0i64;
            let note = NotificationReceivedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    if let Ok(note) = args.Notification() {
                        let mut title = PWSTR::null();
                        let mut body = PWSTR::null();
                        let _ = note.Title(&mut title);
                        let _ = note.Body(&mut body);
                        diag(&format!(
                            "event notification {note_id} -> {} | {}",
                            take_pwstr(title),
                            take_pwstr(body)
                        ));
                    }
                }
                Ok(())
            }));
            let _ = core24.add_NotificationReceived(&note, &mut note_token);
        }
    });
    if posted.is_err() {
        diag("configure -> webview was not available");
    }
}

#[cfg(not(target_os = "windows"))]
fn configure_tab_webview<R: Runtime>(_app: &tauri::AppHandle<R>, _webview: &Webview<R>, _id: &str) {}

/// Ctrl+L from inside a page: move WebView2's focus back to the shell, so the
/// address-bar input the frontend focuses actually receives the typing. The
/// page webview owns the OS focus until this runs, which is why focusing the
/// DOM input alone left the caret in the page.
#[tauri::command]
pub async fn browser_focus_shell(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let Some(shell) = window.webviews().into_iter().find(|w| w.label() == "main") else {
        return Ok(());
    };
    #[cfg(target_os = "windows")]
    shell
        .with_webview(|pw| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
            let _ = pw
                .controller()
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        })
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "windows"))]
    let _ = shell;
    Ok(())
}

/// The OSD flyout's transport buttons. One typed path — the same
/// `smtc::action` target the Win+A card and the earbud use — so a drag on
/// the OSD slider and a press on the flyout can never disagree about what
/// "seek" means.
#[tauri::command]
pub fn browser_media_action(
    app: tauri::AppHandle,
    action: String,
    value: Option<f64>,
) -> Result<(), String> {
    if !matches!(
        action.as_str(),
        "play" | "pause" | "stop" | "next" | "prev" | "forward" | "rewind" | "seek"
    ) {
        return Err(format!("unknown media action: {action}"));
    }
    if action == "seek" {
        let seconds = value
            .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
            .ok_or_else(|| "seek needs a valid position".to_string())?;
        crate::smtc::action(&app, &action, Some(seconds));
    } else {
        crate::smtc::action(&app, &action, None);
    }
    Ok(())
}

/// The OSD flyout's initial state: the owning tab's latest report, or
/// `null` when nothing is playing. The card calls this on mount so a paused
/// video that is no longer heartbeating still shows up.
#[tauri::command]
pub fn browser_media_state(app: tauri::AppHandle) -> Option<crate::smtc::MediaSnapshot> {
    crate::smtc::snapshot(&app)
}

/// Show one tab: destroy/collapse every other tab's webview, then create,
/// navigate, or simply uncover this one.
///
/// This is the only command that brings a page on screen. The store calls
/// it for new tabs, tab switches, address-bar navigation, back/forward and
/// reload — one path, so the webview's state can never disagree with the
/// strip about what is displayed.
///
/// `keep` carries the tab ids (besides the target) whose webview must stay
/// alive — the store passes the tab the user just left. Kept webviews are
/// collapsed to 1×1; everything else is destroyed. `force` bypasses the
/// same-URL fast path (reload button, address re-submit).
/// Show tab `id` at the browser content rect, creating its native webview
/// when needed.
///
/// MUST be an async command: `Window::add_child` posts the webview build
/// onto the main thread and blocks on a channel (`run_on_main_thread` +
/// `rx.recv()`). A sync command already runs ON that main thread, so that
/// recv would block the very event loop that was supposed to run the
/// posted work — creation hangs forever while the UI keeps looking alive
/// (browser-diag.log caught exactly this: "creating child webview" with
/// no "create ok" ever after). Tauri schedules async commands off the
/// main thread, which makes the post/recv round-trip legitimate.
#[tauri::command]
pub async fn browser_show(
    app: tauri::AppHandle,
    id: String,
    url: String,
    keep: Option<Vec<String>>,
    force: Option<bool>,
    resume: Option<bool>,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let rect = measured_rect(&app)?;
    diag(&format!(
        "show id={id} url={url} keep={keep:?} force={force:?} resume={resume:?} rect={rect:?}"
    ));

    // A blank/new tab has nothing to show: the speed dial is plain DOM in
    // the main webview, so the right action is to sweep any live page
    // webview and stop. This is what makes an empty tab cost 0 MB. Pinned
    // tabs are the exception - they stay alive (parked at 1×1) so the music
    // keeps playing behind the speed dial.
    if url.is_empty() || url == "about:blank" {
        // A blank tab has no page webview of its own: the speed dial is plain
        // DOM in the shell. The tab the user just left is *kept* (parked at
        // 1×1), exactly like any other tab switch, so coming back to it is
        // instant; when `keep` is empty every non-pinned webview is swept and
        // the blank tab costs 0 MB. Pinned tabs are always parked, never
        // destroyed — their audio has to keep playing behind the dial.
        let mut keep_labels: Vec<String> = keep
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|tab_id| label_for(tab_id))
            .collect();
        let pinned = pinned_ids(&app);
        for tab_id in &pinned {
            let pinned_label = label_for(tab_id);
            if !keep_labels.iter().any(|k| k == &pinned_label) {
                keep_labels.push(pinned_label);
            }
        }
        for webview in window.webviews() {
            let wl = webview.label();
            if !wl.starts_with("tab-") || !keep_labels.iter().any(|k| k == &wl) {
                continue;
            }
            let keep_awake = pinned.iter().any(|tab_id| label_for(tab_id) == wl);
            park_webview(&webview, keep_awake);
        }
        destroy_others(&window, &keep_labels, &pinned);
        set_active(&app, "");
        diag(&format!("show blank -> swept (kept {keep_labels:?})"));
        return Ok(());
    }

    // A degenerate rect means the content area was never measured (the
    // bind that feeds browser_set_rect failed). Creating the child there
    // yields a permanently invisible webview with no error for anyone —
    // the second silent failure the diag log caught (rect 0×0 in the
    // show line). Fail loudly instead: the toast carries this back.
    if rect.width <= 0.0 || rect.height <= 0.0 {
        diag("show -> rect 0x0, refusing to create an invisible webview");
        return Err("browser content area was not measured yet — try again".to_string());
    }

    let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let label = label_for(&id);

    // The keep-alive set: the target, the tab the user just left, and every
    // pinned tab. Without pins the live set never exceeds two webviews; a pin
    // is the user's explicit exception, because "listen to YouTube for hours"
    // needs the page alive. Pinned-but-hidden webviews are parked at 1×1.
    let mut keep_labels: Vec<String> = vec![label.clone()];
    if let Some(extra) = &keep {
        for tab_id in extra {
            keep_labels.push(label_for(tab_id));
        }
    }
    let pinned_now = pinned_ids(&app);
    for tab_id in &pinned_now {
        let pinned_label = label_for(tab_id);
        if !keep_labels.iter().any(|k| k == &pinned_label) {
            keep_labels.push(pinned_label);
        }
    }

    for webview in window.webviews() {
        let wl = webview.label();
        if !wl.starts_with("tab-") || wl == label {
            continue;
        }
        if keep_labels.iter().any(|k| k == wl) {
            // Kept alive but collapsed: 1×1 px at the content rect's
            // origin. Rendering cost ≈ 0, scroll position and page state
            // intact, and z-order stops mattering because a collapsed
            // webview is effectively invisible. A pinned tab is NOT told to
            // trim: the user explicitly asked for it to stay awake (YouTube
            // audio/video), and LOW is a memory hint the renderer may act on.
            let keep_awake = pinned_now
                .iter()
                .any(|tab_id| label_for(tab_id) == wl);
            park_webview(&webview, keep_awake);
        } else {
            let _ = webview.close();
        }
    }

    match find_tab(&window, &label) {
        Some(webview) => {
            // The target is never collapsed: park it at the content rect.
            let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));

            // Resume: the caller is only bringing a live tab back on screen
            // (view remount, tab switch). The page — not the store — is the
            // source of truth for where it is, because YouTube and friends
            // move with history.pushState and never fire a navigation event.
            // Comparing the store's URL here was what navigated a pinned
            // YouTube video back to the home page the moment the user
            // returned from the editor. `resume` says "show what is there";
            // an address-bar submit passes false and still navigates.
            if resume.unwrap_or(false) {
                set_active(&app, &label);
                set_memory_target(&webview, false);
                report_extensions(&app, &webview, &id);
                diag("show -> resumed live page (no navigation)");
                return Ok(());
            }

            // Fast path: the child is already showing exactly this URL —
            // the kept-tab back-switch. Leave it alone: no reload, scroll
            // intact. `force` (reload button, re-submit) bypasses this.
            if !force.unwrap_or(false) {
                if let Ok(actual) = webview.url() {
                    if actual == parsed {
                        set_active(&app, &label);
                        // Coming back from LOW is the other half of the trim:
                        // the visible page must be render-ready again.
                        set_memory_target(&webview, false);
                        report_extensions(&app, &webview, &id);
                        diag("show kept fast-path (already at url)");
                        return Ok(());
                    }
                }
            }
            diag("show -> navigate existing");
            webview
                .navigate(parsed)
                .map_err(|e| {
                    diag(&format!("navigate ERR {e}"));
                    e.to_string()
                })?;
        }
        None => {
            diag("show -> creating child webview");
            create_tab_webview(&app, &window, &id, parsed, rect)?;
        }
    }
    if let Some(webview) = find_tab(&window, &label) {
        // The visible tab returns to NORMAL and reports the profile's real
        // extension list (the UI's "uBlock loaded" claim).
        set_memory_target(&webview, false);
        report_extensions(&app, &webview, &id);
    }
    set_active(&app, &label);
    Ok(())
}

/// Destroy a tab's webview (tab closed, or the browser view closed). A
/// missing webview is success — nothing to do is not an error.
/// Hide a tab's webview without killing the whole browser UI.
///
/// Async for the same reason as [`browser_show`]: it drives webview
/// handles that marshal work onto the main thread, and a sync command
/// would deadlock that exact thread when it waits.
#[tauri::command]
pub async fn browser_hide(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    // A closed tab is never pinned any more: drop it from the keep set first,
    // or the next show would park a webview for a tab that no longer exists.
    if let Ok(mut set) = app.state::<BrowserState>().pinned.lock() {
        set.remove(&id);
    }
    let label = label_for(&id);
    if let Ok(mut set) = app.state::<BrowserState>().fullscreen.lock() {
        set.remove(&label);
    }
    if let Some(webview) = find_tab(&window, &label) {
        let _ = webview.close();
    }
    crate::smtc::tab_closed(&app, &id);
    if let Ok(mut a) = app.state::<BrowserState>().active.lock() {
        if *a == label {
            *a = String::new();
        }
    }
    Ok(())
}

/// Sweep every tab webview: the browser view unmounted (back to the
/// editor). The ledger drops to zero live webviews — the zero-RAM rule
/// applied to leaving the browser, kept ones included.
/// The browser UI is unmounting: sweep every tab webview.
///
/// Async for the same reason as [`browser_show`] — `close()`/`set_size()`
/// on child webviews marshal onto the main thread internally.
#[tauri::command]
pub async fn browser_view_closed(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    // Pinned tabs are the one thing that survives leaving the browser: that
    // is what "pin YouTube and keep listening while editing" means. They are
    // parked at 1×1 (so they can never paint over the editor) and told to
    // trim; every unpinned webview is destroyed as before.
    let pinned = pinned_ids(&app);
    destroy_others(&window, &[], &pinned);
    // A pinned page keeps playing (that is what pinning is for), so its
    // session survives the unmount. Any other owner was just destroyed.
    crate::smtc::tabs_swept(&app, &pinned);
    if let Ok(mut a) = app.state::<BrowserState>().active.lock() {
        *a = String::new();
    }
    // Nothing is fullscreen once the view is gone; a stale entry would make
    // the next "show the page" restore a window-sized box over the editor.
    if let Ok(mut set) = app.state::<BrowserState>().fullscreen.lock() {
        set.clear();
    }
    diag(&format!(
        "view closed -> swept all, {} pinned kept",
        pinned.len()
    ));
    Ok(())
}

/// Close the shell: destroy every page webview and hand the media session
/// back. Called from the window's close path before the process exits, so a
/// YouTube page can never keep playing after the app is gone.
///
/// Sync on purpose: it runs inside `CloseRequested`, where the async runtime
/// is already winding down, and `Webview::close()` only posts the teardown to
/// the main thread.
pub fn shutdown<R: Runtime>(app: &tauri::AppHandle<R>) {
    let mut closed = 0usize;
    if let Some(window) = app.get_window("main") {
        for webview in window.webviews() {
            if webview.label().starts_with("tab-") {
                let _ = webview.close();
                closed += 1;
            }
        }
    }
    // The SMTC session is the other half of "audio outlives the app": Windows
    // keeps the app in the volume mixer while a session is open, and a stale
    // "playing" state also leaves the media flyout claiming it is alive.
    crate::smtc::tabs_swept(app, &HashSet::new());
    diag(&format!("shutdown -> closed {closed} tab webview(s)"));
}

/// Alt+F4 must close the app even when the key lands in a page webview.
///
/// WebView2 owns a real child HWND, and a system key that arrives while a
/// page has focus is consumed there - the shell's window procedure never sees
/// it. The symptom on this machine was literal: the user pressed Alt+F4, the
/// window stayed open, and a YouTube video kept playing in the background.
/// `AcceleratorKeyPressed` is the documented interception point; it fires for
/// the system key before Chromium acts on it, and closing the window here is
/// exactly the title-bar X.
#[cfg(target_os = "windows")]
fn attach_exit_accelerator<R: Runtime>(
    app: &tauri::AppHandle<R>,
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };
    use webview2_com::AcceleratorKeyPressedEventHandler;

    let close_app = app.clone();
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_sender, args| {
        if let Some(args) = args {
            let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
            let mut key = 0u32;
            // The event args are COM accessors; reading them is unsafe by
            // declaration, and the reads are straight out-params.
            unsafe {
                let _ = args.KeyEventKind(&mut kind);
                let _ = args.VirtualKey(&mut key);
            }
            // VK_F4 = 0x73. `SYSTEM_KEY_DOWN` is the Alt-modified form;
            // Ctrl+F4 stays a regular key and the shim still maps it to
            // "close tab", which is what a browser should do.
            if kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN && key == 0x73 {
                diag("exit accelerator -> Alt+F4, closing the shell");
                if let Some(window) = close_app.get_window("main") {
                    let _ = window.close();
                }
            }
        }
        Ok(())
    }));
    let mut token = 0i64;
    let registered = unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token) };
    if registered.is_err() {
        diag("exit accelerator -> registration failed");
    }
}

/// Register the Alt+F4 intercept on the shell's own webview too. The editor
/// is a WebView2 as well, so the same swallowed-key path applies there.
#[cfg(target_os = "windows")]
pub fn install_exit_accelerator<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.clone();
    let posted = window.with_webview(move |pw| {
        let controller = pw.controller();
        attach_exit_accelerator(&handle, &controller);
    });
    if posted.is_err() {
        diag("exit accelerator -> main webview unavailable");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn install_exit_accelerator<R: Runtime>(_app: &tauri::AppHandle<R>) {}


/// The content box the shell last measured, waiting briefly for the first
/// measurement when a tab is shown in the same tick it is created.
///
/// `browser_set_rect` and `browser_show` are two independent async commands;
/// before this, a new tab opened from the tools panel (which switches to the
/// browser *and* creates the tab) could reach `show` first, read 0x0 and be
/// refused - "nayi tab nahi khul rahi". The measurement lands milliseconds
/// later, so waiting is the correct answer, not an error.
fn measured_rect<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<ContentRect, String> {
    let read = |app: &tauri::AppHandle<R>| -> Result<ContentRect, String> {
        app.state::<BrowserState>()
            .rect
            .lock()
            .map(|r| *r)
            .map_err(|_| "browser rect lock poisoned".to_string())
    };
    let mut rect = read(app)?;
    for _ in 0..50 {
        if rect.width > 0.0 && rect.height > 0.0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        rect = read(app)?;
    }
    Ok(rect)
}

/// Pin or unpin a tab.
///
/// A pinned tab's webview survives every tab switch (and leaving the browser),
/// parked at 1×1 with WebView2's low-memory target, so audio keeps playing
/// while the tab is out of sight. Unpinning makes it ordinary again: if it is
/// not the active tab, its webview is destroyed right away, exactly like any
/// other background tab.
#[tauri::command]
pub async fn browser_set_pinned(
    app: tauri::AppHandle,
    id: String,
    pinned: bool,
) -> Result<(), String> {
    if let Ok(mut set) = app.state::<BrowserState>().pinned.lock() {
        if pinned {
            set.insert(id.clone());
        } else {
            set.remove(&id);
        }
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let label = label_for(&id);
    let active = app
        .state::<BrowserState>()
        .active
        .lock()
        .map(|a| a.clone())
        .unwrap_or_default();

    match find_tab(&window, &label) {
        Some(webview) if active != label && pinned => park_webview(&webview, true),
        Some(webview) if active != label => {
            let _ = webview.close();
            crate::smtc::tab_closed(&app, &id);
        }
        _ => {}
    }

    diag(&format!("pin {id} -> {pinned}"));
    Ok(())
}

/// Record where the browser content area sits in window coordinates.
///
/// Async for the same reason as [`browser_show`] — this state is the
/// creator's argument, so it must never run on the main thread either.
#[tauri::command]
pub async fn browser_set_rect(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let rect = ContentRect { x, y, width, height };
    diag(&format!(
        "set_rect {}x{} @ ({x},{y})",
        width, height
    ));
    *app
        .state::<BrowserState>()
        .rect
        .lock()
        .map_err(|_| "browser rect lock poisoned".to_string())? = rect;

    // A zero-sized rect means the browser view is unmounting: keep the
    // stored value (it re-measures on the next mount) but do not stack a
    // webview at the window origin.
    if width < 2.0 || height < 2.0 {
        return Ok(());
    }

    // Parked for an overlay: the rect is remembered (above) but the page must
    // stay at 1×1 until `browser_set_visible(true)` restores it.
    let state = app.state::<BrowserState>();
    if state.parked.load(Ordering::Relaxed) {
        return Ok(());
    }

    // Only the ACTIVE webview fills the rect. Kept (collapsed) webviews
    // must stay 1×1 — resizing them back would float a stale page over
    // the active one.
    let active = app
        .state::<BrowserState>()
        .active
        .lock()
        .map_err(|_| "browser rect lock poisoned".to_string())?
        .clone();
    if active.is_empty() {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    if let Some(webview) = find_tab(&window, &active) {
        // A fullscreen page covers the window, not the content box: a resize
        // now has to follow the window or the video would keep the old size.
        let fullscreen = state
            .fullscreen
            .lock()
            .map(|set| set.contains(&active))
            .unwrap_or(false);
        if fullscreen {
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window.inner_size().unwrap_or_default();
            let _ = webview.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = webview.set_size(LogicalSize::new(
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            ));
        } else {
            let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
        }
    }
    Ok(())
}

/// Hide the active page while a DOM overlay sits on top of it.
///
/// A child WebView2 always paints **above** the main webview, so the 9-dots
/// tools panel — a DOM popover that crosses the content rect — used to have
/// its lower half covered by the page. While such an overlay is open the
/// active webview is parked at 1×1; when it closes the page is put back on
/// the stored rect. Audio keeps running (the page is never closed).
///
/// Async for the same reason as [`browser_show`]: it drives webview handles
/// that marshal onto the main thread, and a sync command would deadlock it.
#[tauri::command]
pub async fn browser_set_visible(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let state = app.state::<BrowserState>();
    let rect = *state
        .rect
        .lock()
        .map_err(|_| "browser rect lock poisoned".to_string())?;
    let active = state
        .active
        .lock()
        .map_err(|_| "browser active lock poisoned".to_string())?
        .clone();
    if active.is_empty() {
        return Ok(());
    }
    let Some(webview) = find_tab(&window, &active) else {
        return Ok(());
    };
    if visible {
        // A fullscreen page was grown to the window; putting it back on the
        // content rect would throw the user out of the video. Same box, then.
        let fullscreen = state
            .fullscreen
            .lock()
            .map(|set| set.contains(&active))
            .unwrap_or(false);
        if fullscreen {
            let scale = window.scale_factor().unwrap_or(1.0);
            let size = window.inner_size().unwrap_or_default();
            let _ = webview.set_position(LogicalPosition::new(0.0, 0.0));
            let _ = webview.set_size(LogicalSize::new(
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            ));
        } else if rect.width >= 2.0 && rect.height >= 2.0 {
            let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
        }
        set_memory_target(&webview, false);
        diag("overlay -> page restored");
    } else {
        park_webview(&webview, true);
        diag("overlay -> page parked");
    }
    Ok(())
}

/// Find a child webview by its exact label among the window's children.
fn find_tab<R: Runtime>(window: &Window<R>, label: &str) -> Option<Webview<R>> {
    window
        .webviews()
        .into_iter()
        .find(|w| w.label() == label)
}

/// Destroy every `tab-*` child webview not in `keep` (empty = sweep all),
/// except pinned tabs, which are parked at 1×1 instead of destroyed.
fn destroy_others<R: Runtime>(window: &Window<R>, keep: &[String], pinned: &HashSet<String>) {
    for webview in window.webviews() {
        let label = webview.label();
        if !label.starts_with("tab-") || keep.iter().any(|k| k == label) {
            continue;
        }
        if pinned.iter().any(|id| label_for(id) == label) {
            // Pinned: parked but kept awake (no LOW trim), so leaving the
            // browser for the editor does not pause a YouTube video.
            park_webview(&webview, true);
        } else {
            let _ = webview.close();
        }
    }
}

/// Build a tab's webview with the three hooks that keep the store in sync
/// and intercept downloads.
fn build_tab_webview<R: Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    url: Url,
) -> WebviewBuilder<R> {
    let label = label_for(id);

    // Navigation hook: a link click or a redirect moves the URL without the
    // store knowing, so every self-navigation is reported. Returning true
    // allows it; blocking would make the browser useless.
    let nav_app = app.clone();
    let nav_id = id.to_string();
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url))
        // New-window links + the Firefox key map, compiled into the binary.
        // Tauri runs this before any page script, in the main frame only.
        .initialization_script(SHIM)
        // Chromium's media session is off; ours (smtc.rs) is the only one.
        .additional_browser_args(TAB_BROWSER_ARGS)
        .on_navigation(move |target: &Url| {
            // The tab is created at about:blank so the shim is installed
            // before the first real document; that blank commit is not a
            // navigation the store should record.
            if target.scheme() == "about" {
                return true;
            }
            diag(&format!("event nav {} -> {target}", nav_id));
            let _ = nav_app.emit(
                "browser:nav",
                NavPayload {
                    id: nav_id.clone(),
                    url: target.to_string(),
                },
            );
            true
        });

    // Page-load hook: "Finished" clears the strip's spinner and carries the
    // final URL after redirects. The `webview` argument is the tab itself,
    // so the event goes straight to the main window's DOM.
    let page_id = id.to_string();
    let builder = builder.on_page_load(move |webview, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            diag(&format!("event page finished {} -> {}", page_id, payload.url()));
            let _ = webview.emit(
                "browser:page",
                NavPayload {
                    id: page_id.clone(),
                    url: payload.url().to_string(),
                },
            );
        }
    });

    // Title hook: the page's own <title> replaces the hostname in the tab
    // strip and the downloads panel, exactly like a real browser.
    let ttl_app = app.clone();
    let ttl_id = id.to_string();
    let builder = builder.on_document_title_changed(move |_webview, title| {
        let _ = ttl_app.emit(
            "browser:title",
            TitlePayload {
                id: ttl_id.clone(),
                title,
            },
        );
    });

    // New-window hook: target=_blank, Ctrl+click and window.open. Wry's
    // default with no handler is to DENY the request silently, so a search
    // result link (DuckDuckGo opens them via target=_blank) appeared to do
    // nothing. Instead of letting WebView2 spawn its own top-level popup
    // (an untracked second webview — OOM budget and UX both break), deny it
    // here and hand the URL to the store, which opens it as a tab in the
    // strip. No link ever leaves the in-built browser.
    let pop_app = app.clone();
    let pop_id = id.to_string();
    let builder = builder.on_new_window(move |url, _features: NewWindowFeatures| {
        diag(&format!("event popup {} -> {url}", pop_id));
        let _ = pop_app.emit(
            "browser:popup",
            NavPayload {
                id: pop_id.clone(),
                url: url.to_string(),
            },
        );
        NewWindowResponse::Deny
    });

    // Page webviews get their own WebView2 profile. WebView2 refuses two
    // different environments for one user-data folder — and that is exactly
    // what `HRESULT(0x8007139F)` was: the app shell's environment had
    // extensions off, the tab asked for extensions on, same folder. The tab
    // profile is also the browser's own cookie jar, so a UI storage change
    // cannot log the user out of every site.
    let builder = match tabs_profile_dir(app) {
        Some(dir) => {
            diag(&format!("profile -> {}", dir.display()));
            builder.data_directory(dir)
        }
        None => {
            diag("profile -> default (local data dir unavailable)");
            builder
        }
    };

    // Extensions ride on the environment, so they are configured while the
    // webview is still being built — before the consuming hooks below.
    //
    // The switch is always ON for tabs (even before uBlock is unpacked):
    // environment options must stay identical for every tab in this profile.
    // Flipping it on later, after the daemon installs uBlock, would recreate
    // the invalid-state failure. `extensions_path` is the only part that can
    // appear later, and it does not change the environment options.
    let builder = if EXTENSIONS_OFF.load(Ordering::Relaxed) {
        diag("extensions -> off (WebView2 rejected them earlier)");
        builder
    } else {
        let builder = builder.browser_extensions_enabled(true);
        match extensions_dir(app) {
            Some(dir) => {
                diag(&format!("extensions -> {}", dir.display()));
                builder.extensions_path(dir)
            }
            None => {
                diag("extensions -> on, none unpacked yet");
                builder
            }
        }
    };

    // Download hook: WebView2's own download UI never appears — returning
    // false cancels it, and the URL goes to the frontend, which hands it to
    // the daemon's multi-segment downloader (1DM-style speed). The tab's
    // current URL travels as the referer.
    let dl_app = app.clone();
    let dl_id = id.to_string();
    builder.on_download(move |webview, event| {
        if let DownloadEvent::Requested { url, .. } = &event {
            diag(&format!("event download requested {} -> {url}", dl_id));
            let referer = webview.url().ok().map(|u| u.to_string());
            let _ = dl_app.emit(
                "browser:download",
                DownloadPayload {
                    url: url.to_string(),
                    referer,
                },
            );
        }
        // false = cancel WebView2's download; the daemon owns the bytes now.
        false
    })
}

/// Create one tab child, with the one honest fallback.
///
/// If WebView2 rejects the extensions-enabled environment, remember that,
/// disable extensions for the rest of this process, and retry the exact same
/// tab without them. A browser that cannot show a page is worse than a
/// browser without an ad blocker — and the UI reports which one it got via
/// `browser:extensions` instead of pretending.
fn create_tab_webview<R: Runtime>(
    app: &tauri::AppHandle<R>,
    window: &Window<R>,
    id: &str,
    url: Url,
    rect: ContentRect,
) -> Result<Webview<R>, String> {
    let position = LogicalPosition::new(rect.x, rect.y);
    let size = LogicalSize::new(rect.width, rect.height);

    // Create at about:blank first: `initialization_script` only applies to
    // documents created after the webview exists, so the real page is
    // navigated to *after* the shim is in place. The blank commit costs
    // nothing and is filtered out of the store's navigation feed.
    let blank = Url::parse("about:blank").map_err(|e| e.to_string())?;

    match window.add_child(
        build_tab_webview(app, id, blank.clone()),
        position,
        size,
    ) {
        Ok(webview) => {
            diag("create ok");
            configure_tab_webview(app, &webview, id);
            webview.navigate(url).map_err(|e| {
                diag(&format!("create navigate ERR {e}"));
                e.to_string()
            })?;
            Ok(webview)
        }
        Err(first) => {
            let message = first.to_string();
            diag(&format!("create ERR {message}"));
            // A duplicate label is a race with another show for the same tab,
            // not an extension problem. Hand back the child that won - and
            // never let this disable extensions for the whole process (that
            // one misread kept uBlock off for the rest of a session).
            if message.contains("already exists") {
                if let Some(existing) = find_tab(window, &label_for(id)) {
                    return Ok(existing);
                }
            }
            let environment_mismatch =
                message.contains("0x8007139F") || message.contains("0x8007139f");
            if !environment_mismatch
                || EXTENSIONS_OFF.load(Ordering::Relaxed)
                || extensions_dir(app).is_none()
            {
                return Err(message);
            }
            // The folder exists but the runtime would not create an
            // extensions-enabled environment. Remember it so the next tab
            // does not pay the same failure, then retry this one without it.
            EXTENSIONS_OFF.store(true, Ordering::Relaxed);
            diag("extensions -> disabled after create failure; retrying tab");
            window
                .add_child(build_tab_webview(app, id, blank), position, size)
                .map_err(|second| {
                    diag(&format!("create retry ERR {second}"));
                    second.to_string()
                })
                .and_then(|webview| {
                    diag("create ok (extensions off)");
                    configure_tab_webview(app, &webview, id);
                    webview.navigate(url).map_err(|e| {
                        diag(&format!("create navigate ERR {e}"));
                        e.to_string()
                    })?;
                    Ok(webview)
                })
        }
    }
}

/// Esc / the toolbar's stop button: the native half of stopping a load.
#[tauri::command]
pub async fn browser_stop(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    let Some(webview) = find_tab(&window, &label_for(&id)) else {
        return Ok(());
    };
    let _ = webview.with_webview(|pw| unsafe {
        if let Ok(core) = pw.controller().CoreWebView2() {
            let _ = core.Stop();
        }
    });
    diag(&format!("stop {id}"));
    Ok(())
}

/// Diagnostic lane (`T9_BROWSER_SMOKE=1`): build one real tab webview with
/// the production builder, ask WebView2 for its extension list, write the
/// verdict to `browser-diag.log`, then exit.
///
/// Tab creation normally needs a human click. This runs the exact production
/// path (`create_tab_webview` → env options → profile → extensions) on its
/// own, so the installed build can be verified without compiling locally.
#[cfg(target_os = "windows")]
pub fn smoke_probe(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        // Let the main window and its environment finish first: the whole
        // bug was about a second environment, so the order matters.
        std::thread::sleep(std::time::Duration::from_secs(3));
        diag("smoke -> begin");
        let Some(window) = app.get_window("main") else {
            diag("smoke ERR main window missing");
            app.exit(2);
            return;
        };
        let rect = ContentRect {
            x: -2400.0,
            y: -2400.0,
            width: 1.0,
            height: 1.0,
        };
        let Ok(url) = Url::parse("about:blank") else {
            diag("smoke ERR about:blank did not parse");
            app.exit(2);
            return;
        };
        match create_tab_webview(&app, &window, "smoke", url, rect) {
            Ok(webview) => {
                // AddBrowserExtension is asynchronous; give it a moment
                // before asking the profile what it actually loaded.
                std::thread::sleep(std::time::Duration::from_secs(2));
                match extension_list(&webview) {
                    Ok(list) => {
                        diag(&format!("smoke extensions -> {list:?}"));
                        let loaded = list
                            .iter()
                            .any(|(n, e)| n.to_lowercase().contains("ublock") && *e);
                        diag(if loaded {
                            "smoke RESULT ublock=loaded"
                        } else {
                            "smoke RESULT ublock=missing"
                        });
                        let _ = webview.close();
                        app.exit(if loaded { 0 } else { 3 });
                    }
                    Err(err) => {
                        diag(&format!("smoke extensions ERR {err}"));
                        let _ = webview.close();
                        app.exit(3);
                    }
                }
            }
            Err(err) => {
                diag(&format!("smoke create ERR {err}"));
                app.exit(4);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn smoke_probe(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_prefixed_and_unique_per_tab() {
        assert_eq!(label_for("1"), "tab-1");
        assert_eq!(label_for("42"), "tab-42");
        assert_ne!(label_for("1"), label_for("2"));
    }

    /// The regression that blanked every tab: the app shell's environment
    /// had extensions off, the tab's had them on, and both used the same
    /// user-data folder. These two names must stay different.
    #[test]
    fn tabs_use_their_own_profile_folder() {
        let root = std::path::PathBuf::from(r"C:\Users\example\AppData\Local");
        let app_shell = root.join("T9EditorLIT").join("EBWebView");
        let tabs = root.join("T9EditorLIT").join("browser-profile");
        assert_ne!(app_shell, tabs);
    }

    /// The native ad shield: suffix match on the host authority, never a
    /// substring, and only YouTube's ad paths. A video URL that merely
    /// contains "ad" must keep loading.
    #[test]
    fn ad_shield_blocks_hosts_and_spares_playback() {
        assert!(ad_request("https://ads.doubleclick.net/pixel.gif"));
        assert!(ad_request("https://doubleclick.net/x"));
        assert!(ad_request(
            "http://www.googlesyndication.com/pagead/js/adsbygoogle.js"
        ));
        assert!(ad_request("https://www.youtube.com/pagead/abc"));
        assert!(ad_request("https://www.youtube.com/ptracking?x=1"));
        assert!(ad_request("https://www.youtube.com/api/stats/ads?x=1"));

        assert!(!ad_request("https://notdoubleclick.net/x"));
        assert!(!ad_request("https://example.com/ad"));
        assert!(!ad_request("https://www.youtube.com/watch?v=ad"));
        assert!(!ad_request("https://www.youtube.com/api/stats/playback?x=1"));
        assert!(!ad_request(
            "https://rr3---sn-abc.googlevideo.com/videoplayback?x=1"
        ));
    }

    #[test]
    fn payloads_serialize_camel_case() {        let nav = NavPayload {
            id: "3".into(),
            url: "https://example.com".into(),
        };
        let json = serde_json::to_string(&nav).unwrap();
        assert!(json.contains("\"id\":\"3\""));
        assert!(json.contains("\"url\":\"https://example.com\""));

        let dl = DownloadPayload {
            url: "https://example.com/f.mp4".into(),
            referer: Some("https://example.com".into()),
        };
        let json = serde_json::to_string(&dl).unwrap();
        assert!(json.contains("\"referer\""));
        assert!(json.contains("\"url\":\"https://example.com/f.mp4\""));
    }
}
