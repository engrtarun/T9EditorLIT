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
fn diag(msg: &str) {
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
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            rect: Mutex::new(ContentRect::default()),
            active: Mutex::new(String::new()),
        }
    }
}

fn set_active<R: Runtime>(app: &tauri::AppHandle<R>, label: &str) {
    let state = app.state::<BrowserState>();
    if let Ok(mut a) = state.active.lock() {
        *a = label.to_string();
    }
}

/// The webview label for a tab id. The `tab-` prefix keeps child labels
/// from ever colliding with the main window's own name.
fn label_for(id: &str) -> String {
    format!("tab-{id}")
}

/// Set once WebView2 has refused an extensions-enabled environment. Every
/// later tab is then built without extensions instead of paying the exact
/// same failure again; the UI is told the truth through `browser:extensions`.
static EXTENSIONS_OFF: AtomicBool = AtomicBool::new(false);

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

/// Where the Go daemon unpacks uBlock Origin.
///
/// Both processes resolve this folder themselves — the daemon writes it, the
/// webview reads it — so neither has to ask the other before a tab opens.
/// `%LOCALAPPDATA%\T9EditorLIT\ublock\extensions` on Windows; the daemon's
/// `os.UserCacheDir()` lands on the same `%LOCALAPPDATA%`.
///
/// `None` means "not unpacked yet" (first run, offline, or a failed update):
/// the webview is then created without extensions instead of pointing WebView2
/// at an empty folder and pretending.
#[cfg(target_os = "windows")]
fn extensions_dir<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<std::path::PathBuf> {
    let base = app.path().local_data_dir().ok()?;
    let dir = base.join("T9EditorLIT").join("ublock").join("extensions");
    if dir.join("uBlock0.chromium").join("manifest.json").is_file() {
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
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let rect = *app
        .state::<BrowserState>()
        .rect
        .lock()
        .map_err(|_| "browser rect lock poisoned".to_string())?;
    diag(&format!(
        "show id={id} url={url} keep={keep:?} force={force:?} rect={rect:?}"
    ));

    // A blank/new tab has nothing to show: the speed dial is plain DOM in
    // the main webview, so the right action is to sweep any live page
    // webview and stop. This is what makes an empty tab cost 0 MB.
    if url.is_empty() || url == "about:blank" {
        destroy_others(&window, &[]);
        set_active(&app, "");
        diag("show blank -> swept");
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

    // The keep-alive set: the target plus the tab the user just left. The
    // live set never exceeds two webviews, and the kept one is inert.
    let mut keep_labels: Vec<String> = vec![label.clone()];
    if let Some(extra) = &keep {
        for tab_id in extra {
            keep_labels.push(label_for(tab_id));
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
            // webview is effectively invisible.
            let _ = webview.set_size(tauri::LogicalSize::new(1.0, 1.0));
            // Half of the RAM contract: a page that is kept but not visible
            // tells WebView2 to trim. The 1×1 size stops it painting; this
            // stops it hoarding.
            set_memory_target(&webview, true);
        } else {
            let _ = webview.close();
        }
    }

    match find_tab(&window, &label) {
        Some(webview) => {
            // The target is never collapsed: park it at the content rect.
            let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));

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
    let label = label_for(&id);
    if let Some(webview) = find_tab(&window, &label) {
        let _ = webview.close();
    }
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
    destroy_others(&window, &[]);
    if let Ok(mut a) = app.state::<BrowserState>().active.lock() {
        *a = String::new();
    }
    diag("view closed -> swept all");
    Ok(())
}

/// Move the live webview onto the content rectangle the frontend measured.
///
/// Called from an effect watching the container's bounding box, so tab
/// strip changes, the downloads panel opening, and window resizes all keep
/// the page painted in exactly the right hole.
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
        let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
        let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
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

/// Destroy every `tab-*` child webview not in `keep` (empty = sweep all).
fn destroy_others<R: Runtime>(window: &Window<R>, keep: &[String]) {
    for webview in window.webviews() {
        let label = webview.label();
        if label.starts_with("tab-") && !keep.iter().any(|k| k == label) {
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
    let builder = WebviewBuilder::new(label, WebviewUrl::External(url)).on_navigation(
        move |target: &Url| {
            diag(&format!("event nav {} -> {target}", nav_id));
            let _ = nav_app.emit(
                "browser:nav",
                NavPayload {
                    id: nav_id.clone(),
                    url: target.to_string(),
                },
            );
            true
        },
    );

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

    match window.add_child(build_tab_webview(app, id, url.clone()), position, size) {
        Ok(webview) => {
            diag("create ok");
            Ok(webview)
        }
        Err(first) => {
            diag(&format!("create ERR {first}"));
            if EXTENSIONS_OFF.load(Ordering::Relaxed) || extensions_dir(app).is_none() {
                return Err(first.to_string());
            }
            // The folder exists but the runtime would not create an
            // extensions-enabled environment. Remember it so the next tab
            // does not pay the same failure, then retry this one without it.
            EXTENSIONS_OFF.store(true, Ordering::Relaxed);
            diag("extensions -> disabled after create failure; retrying tab");
            window
                .add_child(build_tab_webview(app, id, url), position, size)
                .map_err(|second| {
                    diag(&format!("create retry ERR {second}"));
                    second.to_string()
                })
                .inspect(|_| diag("create ok (extensions off)"))
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

    #[test]
    fn payloads_serialize_camel_case() {
        let nav = NavPayload {
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
