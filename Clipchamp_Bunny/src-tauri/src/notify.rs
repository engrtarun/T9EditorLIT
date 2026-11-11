//! Native notifications for app events that finish while nobody is looking.
//!
//! The in-app toast lives in the webview, so it is invisible the moment the
//! user switches to the editor (or to another app), and *also* while a page is
//! open in the in-built browser (the native page webview paints above the DOM
//! toast). Windows' notification centre is the only place that reaches the
//! user there, and it keeps the message until they read it.
//!
//! The plugin owns the unpackaged-app plumbing (the toast identity and its
//! Start-menu shortcut). This module builds the sentence, flashes the taskbar
//! as a fallback for a suppressed toast, and writes the outcome to
//! `browser-diag.log` — a toast that silently does nothing is indistinguishable
//! from one that was never sent, and that is exactly how "notification nahi
//! aa raha" stays unexplained.

use tauri::Manager;
use tauri_plugin_notification::NotificationExt;

/// Show one native notification. Fire-and-forget for callers, but the result
/// is logged (and returned) so Settings can say *why* nothing appeared.
#[tauri::command]
pub fn app_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    let result = app
        .notification()
        .builder()
        .title(&title)
        .body(&body)
        .show();
    match &result {
        Ok(()) => crate::browser::diag(&format!("notify -> shown: {title}")),
        Err(err) => crate::browser::diag(&format!("notify -> ERR {err}")),
    }

    // Fallback the OS cannot hide behind Focus Assist or a per-app switch:
    // flash the taskbar button when the app is in the background. It is a
    // request, not a modal — Windows treats it as "look over here" and the
    // user can ignore it.
    if let Some(window) = app.get_window("main") {
        if !window.is_focused().unwrap_or(false) {
            let _ = window.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }

    result.map_err(|e| e.to_string())
}
