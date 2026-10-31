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
            let builder = build_tab_webview(&app, &id, parsed);
            window
                .add_child(
                    builder,
                    LogicalPosition::new(rect.x, rect.y),
                    LogicalSize::new(rect.width, rect.height),
                )
                .map_err(|e| {
                    diag(&format!("create ERR {e}"));
                    e.to_string()
                })?;
            diag("create ok");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_prefixed_and_unique_per_tab() {
        assert_eq!(label_for("1"), "tab-1");
        assert_eq!(label_for("42"), "tab-42");
        assert_ne!(label_for("1"), label_for("2"));
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
