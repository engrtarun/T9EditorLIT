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
//!   a margin above the taskbar, never under it. That is the *default*:
//!   a remembered rect wins (see below),
//! * **PiP-style geometry** (Firefox's picture-in-picture was the model) —
//!   grab any chrome that is not a button and drag the card anywhere,
//!   resize it from the native borders (min 240×90), and the rect survives
//!   both the idle destroy and an app restart
//!   (`app_data_dir/media-flyout-geom.txt`),
//! * **X to dismiss** — the close button takes the card down at once,
//!   through the same path a session clear uses,
//! * **auto-hides** five seconds after the last show / seek / media key;
//!   the pointer resting on the card keeps it up and slides that deadline —
//!   and so does any move or resize, so a native drag can never be
//!   destroyed under the cursor,
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
/// Logical minimum — the transport row plus the timeline, clamped so an
/// edge drag cannot swallow the card whole.
const MIN_W: f64 = 240.0;
const MIN_H: f64 = 90.0;
/// Physical-pixel gap from the work-area's right/bottom edge.
const MARGIN: i32 = 16;
/// No show, no seek, no media key for this long → the card leaves.
const IDLE: Duration = Duration::from_secs(5);
/// How often the watchdog re-checks the clock and the pointer.
const POLL: Duration = Duration::from_millis(400);
/// A remembered rect must show at least this much of the card on a monitor
/// that is still connected.
const NEED_VISIBLE: i32 = 48;
/// Tolerance around the card for the pointer check: while resizing from an
/// edge the cursor rides the boundary and can sit a hair outside the rect.
const GRAB: f64 = 8.0;
/// What [`persist`] writes into `app_data_dir` — `x y w h`, physical px.
const GEOM_FILE: &str = "media-flyout-geom.txt";

/// When the flyout was last asked to appear. `None` = nothing to show; the
/// watchdog parks (one sleeping thread, no window work) until a ping.
static LAST_EVENT: Mutex<Option<Instant>> = Mutex::new(None);
/// One watchdog thread for the process, started with the first show.
static WATCHDOG: AtomicBool = AtomicBool::new(false);
/// Whether the window is on screen right now — skips show/hide churn and
/// tells the watchdog there is something to hide.
static VISIBLE: AtomicBool = AtomicBool::new(false);
/// Where the user last put the card (physical pixels). Kept across the
/// idle destroy and flushed to disk on `Destroyed`, so the next session
/// starts where this one ended.
static GEOM: Mutex<Option<Geom>> = Mutex::new(None);

/// One remembered window rect, physical pixels — the space `Moved` /
/// `Resized` report in, so no DPI conversion ever happens here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Geom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

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
    // A page reports media from inside WebMessageReceived, which already runs
    // on the UI thread. The first report calls `ensure()` -> `create()` ->
    // WebviewWindowBuilder::build(), which marshals back onto that same UI
    // thread: a self-deadlock. The installed build froze the instant a
    // YouTube video started (no log line after `event nav`, no cleanup when
    // leaving the browser, no response to a close request). The fullscreen
    // handler below already uses this exact worker-thread pattern; every
    // window operation in a page event handler must use it.
    let handle = app.clone();
    std::thread::spawn(move || {
        diag("media flyout -> ping (deferred to worker)");
        if !ensure(&handle) {
            return;
        }
        if WATCHDOG.swap(true, Ordering::SeqCst) {
            return; // the watchdog is already running
        }
        watchdog(handle);
    });
}

/// The session cleared: take the card down at once instead of waiting out
/// the idle timer over an empty box.
pub fn hide<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(mut slot) = LAST_EVENT.lock() {
        *slot = None;
    }
    // Same reason as `ping`: this is reached from the page's media events
    // (a video ending), so window hide/destroy must not run on the caller's
    // thread. `shutdown()` is the only caller that may do it inline.
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(window) = handle.get_webview_window(LABEL) {
            hide_now(&handle, &window);
            // A hidden webview still holds a renderer process. Destroy it so
            // the 8 GB machine gets the whole card back; `ping` recreates it
            // the next time a page actually plays.
            let _ = window.destroy();
            diag("media flyout -> destroyed (session clear)");
        }
    });
}

/// Create the window if this is the first media ever, then show it.
/// Placement happens only inside [`create`] — re-anchoring on every ping
/// would undo a drag the user just did.
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
    show(&window);
    if !VISIBLE.swap(true, Ordering::SeqCst) {
        diag("media flyout -> shown");
    }
    true
}

/// Build the OSD window: undecorated, above everything, out of the taskbar,
/// and invisible until the first `show`. The DWM polish (rounded corners,
/// no hairline frame) is the main window's own `window_chrome::apply`.
///
/// `resizable(true)` is the PiP half of the deal: an undecorated window
/// gets its resize borders from tao's own `WM_NCHITTEST` (the same path
/// the main window resizes by), so no decoration and no JS are involved.
fn create<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("flyout.html".into()))
        .title("T9 Editor LIT")
        .inner_size(WIDTH, HEIGHT)
        .min_inner_size(MIN_W, MIN_H)
        .resizable(true)
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
    restore(app, &window);
    diag("media flyout -> created");
    Ok(window)
}

/// Put the card down: the remembered rect if it still lands on a connected
/// monitor, else the default bottom-right corner. Runs only when the
/// window is created — never on a ping, so a dragged card stays put.
fn restore<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    if let Some(geom) = remembered(app) {
        let areas: Vec<(i32, i32, u32, u32)> = app
            .available_monitors()
            .map(|monitors| {
                monitors
                    .iter()
                    .map(|monitor| {
                        let area = monitor.work_area();
                        (area.position.x, area.position.y, area.size.width, area.size.height)
                    })
                    .collect()
            })
            .unwrap_or_default();
        if visible_on(&geom, &areas) {
            let _ = window.set_size(tauri::PhysicalSize::new(geom.w, geom.h));
            let _ = window.set_position(tauri::PhysicalPosition::new(geom.x, geom.y));
            diag("media flyout -> restored remembered rect");
            return;
        }
    }
    position(app, window);
}

/// Geometry bookkeeping, fed from `lib.rs`'s window handler for this
/// window's label.
///
/// * `Moved` / `Resized` update the remembered rect **and slide the idle
///   clock** — a native drag runs a modal loop on the UI thread while the
///   watchdog keeps ticking on its own thread; without the touch it could
///   destroy the window mid-drag.
/// * `Destroyed` flushes the rect to disk (idle destroy, session clear,
///   app shutdown), so the next run restores it.
pub fn on_window_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: &tauri::WindowEvent,
) {
    match event {
        tauri::WindowEvent::Moved(pos) => {
            write_geom(|geom| geom.x = pos.x);
            write_geom(|geom| geom.y = pos.y);
            touch();
        }
        tauri::WindowEvent::Resized(size) => {
            if size.width > 0 && size.height > 0 {
                write_geom(|geom| geom.w = size.width);
                write_geom(|geom| geom.h = size.height);
                touch();
            }
        }
        tauri::WindowEvent::Destroyed => persist(app),
        _ => {}
    }
}

/// Apply one field update to the remembered rect, seeding it from the
/// default card size when the first event of the process arrives.
fn write_geom(f: impl FnOnce(&mut Geom)) {
    if let Ok(mut slot) = GEOM.lock() {
        let geom = slot.get_or_insert(Geom {
            x: 0,
            y: 0,
            w: WIDTH as u32,
            h: HEIGHT as u32,
        });
        f(geom);
    }
}

/// The rect to restore: the in-memory one (always at least as fresh as the
/// file) or, before any event this process, the file a previous run left.
fn remembered<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Geom> {
    if let Ok(slot) = GEOM.lock()
        && let Some(geom) = *slot
    {
        return Some(geom);
    }
    let dir = app.path().app_data_dir().ok()?;
    let text = std::fs::read_to_string(dir.join(GEOM_FILE)).ok()?;
    parse_geom(&text)
}

/// Flush the remembered rect — called on `Destroyed`, so a card the user
/// dragged stays where they left it next session.
fn persist<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Ok(slot) = GEOM.lock() else {
        return;
    };
    let Some(geom) = *slot else {
        return;
    };
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(
        dir.join(GEOM_FILE),
        format!("{} {} {} {}", geom.x, geom.y, geom.w, geom.h),
    );
}

/// `x y w h` in physical pixels, as [`persist`] writes it. A rect smaller
/// than the card's minimum (the minimum shrank between versions) clamps
/// instead of failing.
fn parse_geom(text: &str) -> Option<Geom> {
    let mut nums = text.split_whitespace().map(|v| v.parse::<i32>().ok());
    let x = nums.next()??;
    let y = nums.next()??;
    let w = nums.next()??;
    let h = nums.next()??;
    Some(Geom {
        x,
        y,
        w: w.max(MIN_W as i32) as u32,
        h: h.max(MIN_H as i32) as u32,
    })
}

/// Is enough of the remembered card still on *some* monitor's work area?
/// The monitor it lived on may be gone after a restart — a card restored
/// onto a disconnected screen is a card nobody can reach.
fn visible_on(geom: &Geom, areas: &[(i32, i32, u32, u32)]) -> bool {
    areas.iter().any(|(x, y, w, h)| {
        let overlap_x = (geom.x + geom.w as i32).min(x + *w as i32) - geom.x.max(*x);
        let overlap_y = (geom.y + geom.h as i32).min(y + *h as i32) - geom.y.max(*y);
        overlap_x >= NEED_VISIBLE && overlap_y >= NEED_VISIBLE
    })
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
    // Belt: the `Destroyed` event may not arrive while the loop is already
    // tearing down, and the rect must outlive the process either way.
    persist(app);
    if let Some(window) = app.get_webview_window(LABEL) {
        // `closable(false)` only removes the OS close button; `destroy` is the
        // programmatic path and cannot be intercepted.
        let _ = window.destroy();
        diag("media flyout -> destroyed on shutdown");
    }
}

/// The card's X button (`MediaFlyout.svelte` → `ipc.ts::mediaFlyoutClose`):
/// take it down now instead of waiting out the idle timer. The same path a
/// session clear uses — hide, hand focus back to the main window, destroy
/// the renderer. The next transport transition recreates the card.
#[tauri::command]
pub fn media_flyout_close(app: tauri::AppHandle) {
    hide(&app);
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
        // Idle: free the webview instead of parking a hidden renderer for the
        // rest of the session. The next play/pause recreates it in ~200 ms.
        let _ = window.destroy();
        diag("media flyout -> destroyed (idle)");
    }
}

/// Is the cursor on the card right now? Desktop coordinates on both sides
/// (`cursor_position` and `outer_position` share the desktop's origin), so
/// a second monitor with negative offsets works without special cases.
/// `GRAB` of tolerance: an edge resize rides the boundary, and the cursor
/// may sit a hair outside the rect while the modal sizing loop runs.
fn pointer_on<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> bool {
    let (Ok(cursor), Ok(pos), Ok(size)) = (
        window.cursor_position(),
        window.outer_position(),
        window.outer_size(),
    ) else {
        return false;
    };
    let (left, top) = (pos.x as f64 - GRAB, pos.y as f64 - GRAB);
    let (right, bottom) = (
        left + size.width as f64 + GRAB * 2.0,
        top + size.height as f64 + GRAB * 2.0,
    );
    cursor.x >= left && cursor.x < right && cursor.y >= top && cursor.y < bottom
}

#[cfg(test)]
mod tests {
    use super::{MARGIN, MIN_H, MIN_W, Geom, origin_in, parse_geom, visible_on};

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

    #[test]
    fn parses_the_rect_that_persist_writes() {
        let text = format!("{} {} {} {}", -1920, 40, 640, 360);
        assert_eq!(
            parse_geom(&text),
            Some(Geom {
                x: -1920,
                y: 40,
                w: 640,
                h: 360
            })
        );
        assert_eq!(parse_geom(""), None);
        assert_eq!(parse_geom("junk"), None);
        assert_eq!(parse_geom("1 2"), None);
    }

    #[test]
    fn a_rect_from_before_the_minimum_shrank_clamps_up() {
        let geom = parse_geom("10 10 40 40").expect("parseable");
        assert!(geom.w >= MIN_W as u32, "width clamps to the minimum");
        assert!(geom.h >= MIN_H as u32, "height clamps to the minimum");
    }

    #[test]
    fn a_card_on_a_gone_monitor_is_not_restored() {
        let work = [(0, 0, 1920, 1032)];
        // comfortably inside → restore
        assert!(visible_on(
            &Geom {
                x: 1500,
                y: 900,
                w: 372,
                h: 104
            },
            &work
        ));
        // 1600 px past a single monitor's right edge → not
        assert!(!visible_on(
            &Geom {
                x: 3500,
                y: 900,
                w: 372,
                h: 104
            },
            &work
        ));
        // only 32 px above the taskbar (< NEED_VISIBLE) → not
        assert!(!visible_on(
            &Geom {
                x: 1500,
                y: 1000,
                w: 372,
                h: 104
            },
            &work
        ));
        // no monitors at all → not
        assert!(!visible_on(
            &Geom {
                x: 0,
                y: 0,
                w: 372,
                h: 104
            },
            &[]
        ));
    }
}
