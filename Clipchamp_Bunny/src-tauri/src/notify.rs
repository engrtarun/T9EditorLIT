//! Native notifications for app events that finish while nobody is looking.
//!
//! The in-app toast lives in the webview, so it is invisible the moment the
//! user switches to the editor (or to another app). A 20-minute download is
//! exactly that case: it starts while the browser is open and finishes while
//! the timeline is. Windows' notification centre is the only place that
//! reaches the user there, and it keeps the message until they read it.
//!
//! The plugin owns the unpackaged-app plumbing (the toast identity and its
//! Start-menu shortcut). This module only builds the sentence; a notification
//! that cannot be shown must never fail the thing it is reporting, so callers
//! ignore the error.

use tauri_plugin_notification::NotificationExt;

/// Show one native notification. Deliberately fire-and-forget: a toast is a
/// courtesy, not part of any transaction.
#[tauri::command]
pub fn app_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
