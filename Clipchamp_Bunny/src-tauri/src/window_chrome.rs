//! Windows-only polish for the undecorated window.
//!
//! The app draws its own top bar *and* its own caption buttons (see
//! `src/lib/components/WindowControls.svelte`), so the window is created
//! undecorated — `decorations: false` in `tauri.conf.json` — and Tauri's
//! `shadow: true` gives it back the DWM drop shadow plus Windows 11's rounded
//! corners. What `shadow: true` also gives it is a 1 px frame painted in the
//! system colour, i.e. a bright hairline around a `#15171B` app.
//!
//! Two DWM attributes remove that hairline. Both exist since Windows 11 21H2:
//!
//! * `DWMWA_WINDOW_CORNER_PREFERENCE` = round — state the rounded corners
//!   explicitly instead of relying on whatever the composition decided.
//! * `DWMWA_BORDER_COLOR` = none — drop the 1 px frame so the app dissolves
//!   into its own rounded silhouette.
//!
//! On Windows 10 both calls return `E_INVALIDARG` because the attributes do
//! not exist; the results are ignored on purpose. The window is still correct
//! there, it simply keeps the older square frame.
//!
//! Nothing here allocates, nothing is stored, and it runs exactly once per
//! window — this is the "zero-RAM" version of window chrome: two attribute
//! writes, no hooks, no window-procedure subclass, no per-frame work.

use std::ffi::c_void;

/// `DWMWINDOWATTRIBUTE::DWMWA_WINDOW_CORNER_PREFERENCE`
const DWMWA_WINDOW_CORNER_PREFERENCE: u32 = 33;
/// `DWMWINDOWATTRIBUTE::DWMWA_BORDER_COLOR`
const DWMWA_BORDER_COLOR: u32 = 34;
/// `DWM_WINDOW_CORNER_PREFERENCE::DWMWCP_ROUND`
const DWMWCP_ROUND: u32 = 2;
/// `DWMWA_COLOR_NONE` — "do not draw a border".
const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

// Declared by hand instead of pulling in the `windows`/`windows-sys` crates:
// two attribute writes are not worth a new dependency (and the extra compile
// time it costs on this machine). `dwmapi.dll` ships with Windows itself.
#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *const c_void,
        size: u32,
    ) -> i32;
}

/// Apply the polish. Harmless to call on any Windows version.
pub fn apply(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as *mut c_void;

    // SAFETY: `hwnd` belongs to a live window owned by this app (it is the
    // handle Tauri just returned for `window`), and `set_u32` hands DWM a
    // pointer to a `u32` that outlives the call.
    unsafe {
        set_u32(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND);
        set_u32(hwnd, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE);
    }
}

/// Write one `u32`-sized DWM attribute, ignoring "this Windows is too old".
unsafe fn set_u32(hwnd: *mut c_void, attribute: u32, value: u32) {
    // SAFETY: the caller guarantees `hwnd` is a live window handle and that
    // `value` lives for the duration of the call.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            attribute,
            &value as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}
