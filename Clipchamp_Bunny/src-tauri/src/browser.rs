//! The in-built browser's native half: one WebView2 child per tab.
//!
//! The design that makes the 500 MB budget structural rather than policed:
//! **only the active tab ever has a webview**. Switching tabs destroys the
//! old child and creates a new one for the target tab's URL, so at most one
//! WebView2 process backs the browser no matter how many tabs are open
//! (nine is the cap). An empty tab costs zero bytes — no webview exists
//! until a real URL is navigated to, which is also why the speed dial
//! renders in the main webview's DOM.
//!
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

use std::sync::Mutex;

use serde::Serialize;
use tauri::webview::{
    DownloadEvent, NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder,
};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview, WebviewUrl, Window,
};

/// A page or self-navigation report. Mirrors what the store needs to update
/// one tab row (`camelCase` over the wire).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavPayload {
    pub id: String,
    pub url: String,
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
/// content area (`[data-focus="browser-content"]`).
pub struct BrowserState {
    rect: Mutex<ContentRect>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            rect: Mutex::new(ContentRect::default()),
        }
    }
}

/// The webview label for a tab id. The `tab-` prefix keeps child labels
/// from ever colliding with the main window's own name.
fn label_for(id: &str) -> String {
    format!("tab-{id}")
}

/// Show one tab: destroy every other tab's webview, then create or navigate
/// this one.
///
/// This is the only command that brings a page on screen. The store calls
/// it for new tabs, tab switches, address-bar navigation, back/forward and
/// reload — one path, so the webview's state can never disagree with the
/// strip about what is displayed.
#[tauri::command]
pub fn browser_show(app: tauri::AppHandle, id: String, url: String) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let rect = *app
        .state::<BrowserState>()
        .rect
        .lock()
        .map_err(|_| "browser rect lock poisoned".to_string())?;

    // A blank/new tab has nothing to show: the speed dial is plain DOM in
    // the main webview, so the right action is to destroy any live page
    // webview and stop. This is what makes an empty tab cost 0 MB.
    if url.is_empty() || url == "about:blank" {
        destroy_others(&window, "");
        return Ok(());
    }

    let parsed = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    let label = label_for(&id);

    // One live webview: everything not this tab goes.
    destroy_others(&window, &label);

    match find_tab(&window, &label) {
        Some(webview) => {
            // Already live — navigating to the same URL is a reload, which
            // is exactly what the reload button should do.
            webview.navigate(parsed).map_err(|e| e.to_string())
        }
        None => {
            let builder = build_tab_webview(&app, &id, parsed);
            window
                .add_child(
                    builder,
                    LogicalPosition::new(rect.x, rect.y),
                    LogicalSize::new(rect.width, rect.height),
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

/// Destroy a tab's webview (tab closed, or the browser view closed). A
/// missing webview is success — nothing to do is not an error.
#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let label = label_for(&id);
    if let Some(webview) = find_tab(&window, &label) {
        let _ = webview.close();
    }
    Ok(())
}

/// Move the live webview onto the content rectangle the frontend measured.
///
/// Called from an effect watching the container's bounding box, so tab
/// strip changes, the downloads panel opening, and window resizes all keep
/// the page painted in exactly the right hole.
#[tauri::command]
pub fn browser_set_rect(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let rect = ContentRect { x, y, width, height };
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

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    for webview in window.webviews() {
        if webview.label().starts_with("tab-") {
            let _ = webview.set_position(LogicalPosition::new(rect.x, rect.y));
            let _ = webview.set_size(LogicalSize::new(rect.width, rect.height));
        }
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

/// Destroy every `tab-*` child webview except `keep` (empty = destroy all).
fn destroy_others<R: Runtime>(window: &Window<R>, keep: &str) {
    for webview in window.webviews() {
        let label = webview.label();
        if label.starts_with("tab-") && label != keep {
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
            let _ = webview.emit(
                "browser:page",
                NavPayload {
                    id: page_id.clone(),
                    url: payload.url().to_string(),
                },
            );
        }
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
    builder.on_download(move |webview, event| {
        if let DownloadEvent::Requested { url, .. } = &event {
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
