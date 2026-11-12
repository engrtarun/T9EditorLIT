//! The media OSD flyout — Windows' `02:22 ─── 18:11`, where Windows has none.
//!
//! Windows' own media card (Win + A / Win + N) renders neither time labels
//! nor a draggable seek bar. Its SMTC timeline is a *hint* the panel may
//! draw, and this machine's panel draws none (that is also why Windhawk
//! mods exist that inject a progress bar). The controllable timeline
//! therefore lives in a second, tiny window in the taskbar's corner — the
//! same corner Windows uses for its own OSDs:
//!
//! * **created on demand** — a second webview costs resident RAM on an 8 GB
//!   machine, so nothing exists until a page actually plays media,
//! * **shown without activating** (`SW_SHOWNOACTIVATE`) — keyboard focus
//!   must never leave the page just because a video started,
//! * **positioned on the main window's monitor work area** — bottom-right,
//!   a margin above the taskbar, never under it,
//! * **auto-hides** five seconds after the last show / seek / media key;
//!   the pointer resting on the card keeps it up and slides that deadline,
//! * **hidden at once** when the session clears (`smtc::clear`).
//!
//! It appears only on *transitions* — play, pause, fresh owner, any
//! transport button, any seek. Position-only heartbeats (every ~1.5 s while
//! playing) deliberately do not bring it back: watching a video must not
//! leave a permanent mini player on screen.
//!
//! The page inside is `flyout.html` → `src/flyout.ts` →
//! `MediaFlyout.svelte`: a view of the same `browser:media` snapshot the
//! SMTC session paints, with every button returning through
//! `browser_media_action`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::browser::diag;

/// The window label; must also appear in `capabilities/default.json`.
const LABEL: &str = "media-flyout";
/// Logical size — the card plus a pixel of breathing room.
const WIDTH: f64 = 372.0;
const HEIGHT: f64 = 104.0;
/// Physical-pixel gap from the work-area's right/bottom edge.
const MARGIN: i32 = 16;
/// No show, no seek, no media key for this long → the card leaves.
const IDLE: Duration = Duration::from_secs(5);
/// How often the watchdog re-checks the clock and the pointer.
const POLL: Duration = Duration::from_millis(400);

/// When the flyout was last asked to appear. `None` = nothing to show; the
/// watchdog parks (one sleeping thread, no window work) until a ping.
static LAST_EVENT: Mutex<Option<Instant>> = Mutex::new(None);
/// One watchdog thread for the process, started with the first show.
static WATCHDOG: AtomicBool = AtomicBool::new(false);
/// Whether the window is on screen right now — skips show/hide churn and
/// tells the watchdog there is something to hide.
static VISIBLE: AtomicBool = AtomicBool::new(false);

fn touch() {
    if let Ok(mut slot) = LAST_EVENT.lock() {
        *slot = Some(Instant::now());
    }
}

/// Something worth showing happened: a play/pause transition, a fresh
/// owner, a transport button, a seek. The window is created here the first
/// time, positioned, and shown — without taking keyboard focus from the
/// page.
pub fn ping<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    touch();
    if !ensure(app) {
        return;
    }
    if WATCHDOG.swap(true, Ordering::SeqCst) {
        return; // the watchdog is already running
    }
    let handle = app.clone();
    std::thread::spawn(move || watchdog(handle));
}

/// The session cleared: take the card down at once instead of waiting out
/// the idle timer over an empty box.
pub fn hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(mut slot) = LAST_EVENT.lock() {
        *slot = None;
    }
    if let Some(window) = app.get_webview_window(LABEL) {
        hide_now(app, &window);
    }
}

/// Create the window if this is the first media ever, put it on the work
/// area's bottom-right corner and show it.
fn ensure<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => match create(app) {
            Ok(window) => window,
            Err(error) => {
                diag(&format!("media flyout -> create failed: {error}"));
                return false;
            }
        },
    };
    position(app, &window);
    show(&window);
    if !VISIBLE.swap(true, Ordering::SeqCst) {
        diag("media flyout -> shown");
    }
    true
}

/// Build the OSD window: undecorated, above everything, out of the taskbar,
/// and invisible until the first `show`. The DWM polish (rounded corners,
/// no hairline frame) is the main window's own `window_chrome::apply`.
fn create<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("flyout.html".into()))
        .title("T9 Editor LIT")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible(false)
        .build()?;
    #[cfg(target_os = "windows")]
    crate::window_chrome::apply(&window);
    diag("media flyout -> created");
    Ok(window)
}

/// Bottom-right of the **main window's** monitor work area (so a second
/// screen behaves too), falling back to the flyout's own / the primary one.
/// Physical pixels all the way: work area, window size and position share
/// one coordinate space, so a 150 % display needs no conversion here.
fn position<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let area = monitor.work_area();
    let (x, y) = origin_in(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        size.width,
        size.height,
    );
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// The window origin: inside the work area's bottom-right corner by
/// `MARGIN`. Pure so the taskbar rule can be unit-tested without a window.
fn origin_in(work_x: i32, work_y: i32, work_w: u32, work_h: u32, w: u32, h: u32) -> (i32, i32) {
    (
        work_x + work_w as i32 - w as i32 - MARGIN,
        work_y + work_h as i32 - h as i32 - MARGIN,
    )
}

/// Show the card **without activating it**.
///
/// Tauri's `show()` maps to `SW_SHOW`, which activates the window — and an
/// activated OSD steals keyboard focus from the page (the next spacebar
/// would go to the flyout instead of the video). `SW_SHOWNOACTIVATE` keeps
/// the input focus exactly where it was; clicking the card later is the
/// user's own choice, and `hide_now` gives focus back afterwards.
#[cfg(target_os = "windows")]
fn show<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = window.hwnd() {
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    } else {
        let _ = window.show();
    }
}

#[cfg(not(target_os = "windows"))]
fn show<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let _ = window.show();
}

/// Take the card down. If the user had clicked it (it holds focus), the
/// main window gets that focus back — the page must be typeable again the
/// moment the OSD leaves.
fn hide_now<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    if !VISIBLE.swap(false, Ordering::SeqCst) {
        return;
    }
    let was_focused = window.is_focused().unwrap_or(false);
    let _ = window.hide();
    if was_focused
        && let Some(main) = app.get_webview_window("main")
    {
        let _ = main.set_focus();
    }
    diag("media flyout -> hidden");
}

/// Destroy the card's window on app shutdown.
///
/// The flyout is a *hidden window*, and Tauri keeps the event loop alive
/// while any window exists. That is why a closed shell left a live process:
/// `t9-editor-lit.exe` stayed in Task Manager, the single-instance plugin
/// refused to open a second window, and the user's icon click did nothing.
/// Closing the main window now destroys this one too, so the process can end.
pub fn shutdown<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        // `closable(false)` only removes the OS close button; `destroy` is the
        // programmatic path and cannot be intercepted.
        let _ = window.destroy();
        diag("media flyout -> destroyed on shutdown");
    }
}

/// One thread for the process: hide the card `IDLE` after the last event,
/// unless the pointer is resting on it (which slides the deadline).
/// Parked — a lock read and two sleeps — while nothing has ever shown.
fn watchdog<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    loop {
        std::thread::sleep(POLL);
        let Some(last) = LAST_EVENT.lock().ok().and_then(|slot| *slot) else {
            continue; // cleared, or never shown: nothing to police
        };
        if !VISIBLE.load(Ordering::SeqCst) {
            continue;
        }
        if last.elapsed() < IDLE {
            continue;
        }
        let Some(window) = app.get_webview_window(LABEL) else {
            continue;
        };
        if pointer_on(&window) {
            touch(); // hovering keeps it up; the clock restarts on leave
            continue;
        }
        hide_now(&app, &window);
    }
}

/// Is the cursor on the card right now? Desktop coordinates on both sides
/// (`cursor_position` and `outer_position` share the desktop's origin), so
/// a second monitor with negative offsets works without special cases.
fn pointer_on<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let (Ok(cursor), Ok(pos), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    let (left, top) = (pos.x as f64, pos.y as f64);
    let (right, bottom) = (left + size.width as f64, top + size.height as f64);
    cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom
}

#[cfg(test)]
mod tests {
    use super::{MARGIN, origin_in};

    #[test]
    fn sits_inside_the_work_area_bottom_right() {
        // 1920×1080 with a 48 px taskbar: work area ends at y = 1032.
        let (x, y) = origin_in(0, 0, 1920, 1032, 558, 156);
        assert_eq!(x, 1920 - 558 - MARGIN);
        assert_eq!(y, 1032 - 156 - MARGIN);
        assert!(y + 156 <= 1032, "the card must never sit under the taskbar");
    }

    #[test]
    fn negative_origin_survives_a_left_secondary_monitor() {
        let (x, y) = origin_in(-1920, 0, 1920, 1032, 558, 156);
        assert_eq!(x, -1920 + 1920 - 558 - MARGIN);
        assert_eq!(y, 1032 - 156 - MARGIN);
    }
}
