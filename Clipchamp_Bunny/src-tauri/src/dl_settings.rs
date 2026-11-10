//! Downloader settings — the Database of Record.
//!
//! The Go daemon owns the sockets, but it must **not** own the settings: the
//! supervisor restarts it (and the updater swaps the binary), so anything it
//! remembers in memory is gone by the next launch. SQLite is the durable copy;
//! the app writes it here and pushes the resolved values to
//! `PUT /v1/dl/settings`, and the daemon answers with what it is *actually*
//! using (clamped socket count, absolute folder).
//!
//! One row, `id = 1`. A table rather than a key/value blob because these are
//! typed values that the UI edits field by field, and "the save was half
//! written" must never be a state the next launch can read.

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Mirrors `dl.DefaultSegments` on the Go side. Kept as a literal because the
/// two languages do not share a header; the daemon clamps whatever it is sent,
/// so a drift here is cosmetic, never a broken download.
pub const DEFAULT_CONNECTIONS: i64 = 8;
/// Mirrors `dl.HardMaxSegments`.
pub const MAX_CONNECTIONS: i64 = 16;

/// What the Downloads settings popover edits.
///
/// `saveDir` is always absolute once it comes back from [`normalize`]; the UI
/// shows the resolved folder rather than an empty string, so "Downloads" is
/// never a guess about which Downloads folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlSettings {
    pub connections: i64,
    pub save_dir: String,
    pub auto_resume: bool,
    pub notify_done: bool,
}

impl Default for DlSettings {
    fn default() -> Self {
        Self {
            connections: DEFAULT_CONNECTIONS,
            save_dir: String::new(),
            auto_resume: true,
            notify_done: true,
        }
    }
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS dl_settings (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    connections INTEGER NOT NULL,
    save_dir    TEXT    NOT NULL,
    auto_resume INTEGER NOT NULL,
    notify_done INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
";

const PRAGMAS: &str = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;";

/// Open the app database and make sure the settings table exists.
fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("app data folder ban nahi paya: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("settings db open: {e}"))?;
    conn.execute_batch(PRAGMAS)
        .and_then(|_| conn.execute_batch(SCHEMA))
        .map_err(|e| format!("settings table: {e}"))?;
    Ok(conn)
}

/// Empty values get the real folder instead of an empty string, and the
/// socket count is clamped here as well as in the daemon. Two clamps, one
/// truth: the UI never gets to display 99 connections.
fn normalize(mut s: DlSettings, fallback_dir: &Path) -> Result<DlSettings, String> {
    if s.connections <= 0 {
        s.connections = DEFAULT_CONNECTIONS;
    }
    s.connections = s.connections.clamp(1, MAX_CONNECTIONS);

    if s.save_dir.trim().is_empty() {
        s.save_dir = fallback_dir.to_string_lossy().into_owned();
    }
    s.save_dir = s.save_dir.trim().to_string();
    fs::create_dir_all(&s.save_dir)
        .map_err(|e| format!("download folder ban nahi paya ({}): {e}", s.save_dir))?;

    Ok(s)
}

/// Read the saved row, or the defaults when nothing was ever saved.
pub fn load(path: &Path, fallback_dir: &Path) -> Result<DlSettings, String> {
    let conn = open(path)?;
    let row = conn
        .query_row(
            "SELECT connections, save_dir, auto_resume, notify_done FROM dl_settings WHERE id = 1",
            [],
            |row| {
                Ok(DlSettings {
                    connections: row.get(0)?,
                    save_dir: row.get(1)?,
                    auto_resume: row.get::<_, i64>(2)? != 0,
                    notify_done: row.get::<_, i64>(3)? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("settings read: {e}"))?;

    normalize(row.unwrap_or_default(), fallback_dir)
}

/// Persist the settings and return what was actually stored (normalised).
pub fn save(path: &Path, settings: DlSettings, fallback_dir: &Path) -> Result<DlSettings, String> {
    let stored = normalize(settings, fallback_dir)?;
    let conn = open(path)?;
    conn.execute(
        "INSERT INTO dl_settings (id, connections, save_dir, auto_resume, notify_done, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
             connections = excluded.connections,
             save_dir    = excluded.save_dir,
             auto_resume = excluded.auto_resume,
             notify_done = excluded.notify_done,
             updated_at  = excluded.updated_at",
        params![
            stored.connections,
            stored.save_dir,
            stored.auto_resume as i64,
            stored.notify_done as i64,
            now_millis(),
        ],
    )
    .map_err(|e| format!("settings save: {e}"))?;
    Ok(stored)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `<app_data>/nanamicut.db` — the same file the transcript and project tables
/// live in. One database, one WAL, one backup story.
pub fn app_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app data folder: {e}"))?;
    Ok(dir.join("nanamicut.db"))
}

/// Where an empty `saveDir` resolves to.
fn fallback_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path()
        .download_dir()
        .map_err(|e| format!("Downloads folder: {e}"))
}

#[tauri::command]
pub fn dl_settings_get(app: tauri::AppHandle) -> Result<DlSettings, String> {
    let db = app_db_path(&app)?;
    let fallback = fallback_dir(&app)?;
    load(&db, &fallback)
}

#[tauri::command]
pub fn dl_settings_save(
    app: tauri::AppHandle,
    settings: DlSettings,
) -> Result<DlSettings, String> {
    let db = app_db_path(&app)?;
    let fallback = fallback_dir(&app)?;
    save(&db, settings, &fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "t9-dl-settings-{}-{}-{}.db",
            name,
            std::process::id(),
            nanos
        ))
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "t9-dl-settings-{}-{}-{}-dir",
            name,
            std::process::id(),
            nanos
        ))
    }

    #[test]
    fn empty_database_reports_the_defaults_with_a_real_folder() {
        let db = temp_db("defaults");
        let fallback = temp_dir("defaults");
        let got = load(&db, &fallback).expect("load");
        assert_eq!(got.connections, DEFAULT_CONNECTIONS);
        assert_eq!(got.save_dir, fallback.to_string_lossy());
        assert!(got.auto_resume);
        assert!(got.notify_done);
        assert!(fallback.is_dir(), "the fallback folder should exist");
        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_dir_all(&fallback);
    }

    #[test]
    fn save_round_trips_and_clamps_out_of_range_values() {
        let db = temp_db("roundtrip");
        let fallback = temp_dir("roundtrip");
        let target = fallback.join("nested").join("clips");

        let stored = save(
            &db,
            DlSettings {
                connections: 99,
                save_dir: target.to_string_lossy().into_owned(),
                auto_resume: false,
                notify_done: false,
            },
            &fallback,
        )
        .expect("save");
        assert_eq!(stored.connections, MAX_CONNECTIONS);
        assert!(target.is_dir(), "the save folder must be created");

        let again = load(&db, &fallback).expect("load");
        assert_eq!(again, stored);

        let zero = save(
            &db,
            DlSettings {
                connections: 0,
                save_dir: String::new(),
                auto_resume: true,
                notify_done: true,
            },
            &fallback,
        )
        .expect("save zero");
        assert_eq!(zero.connections, DEFAULT_CONNECTIONS);
        assert_eq!(zero.save_dir, fallback.to_string_lossy());

        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_dir_all(&fallback);
    }

    #[test]
    fn a_second_save_updates_the_single_row() {
        let db = temp_db("update");
        let fallback = temp_dir("update");
        for conns in [2, 12] {
            save(
                &db,
                DlSettings {
                    connections: conns,
                    save_dir: fallback.to_string_lossy().into_owned(),
                    auto_resume: true,
                    notify_done: true,
                },
                &fallback,
            )
            .expect("save");
        }
        let got = load(&db, &fallback).expect("load");
        assert_eq!(got.connections, 12);

        let conn = open(&db).expect("open");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM dl_settings", [], |r| r.get(0))
            .expect("count");
        assert_eq!(rows, 1, "settings are one row, not an append-only log");

        let _ = std::fs::remove_file(&db);
        let _ = std::fs::remove_dir_all(&fallback);
    }
}
