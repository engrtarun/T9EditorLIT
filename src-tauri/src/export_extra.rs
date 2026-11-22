//! Disk-backed support for the export panel: history, preflight and capability
//! reporting. Everything here is either pure arithmetic or a small SQLite
//! transaction — no media bytes, no FFmpeg child, no heap buffer that grows
//! with the source file (AGENTS.md §1).
//!
//! The shipping app compiles this module through a `#[path]` include from
//! `Clipchamp_Bunny/src-tauri/src/lib.rs`; the command wrappers live there.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One user-facing export record. Mirrors `ExportHistoryRow` in `types.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportHistoryRow {
    pub id: i64,
    pub created_at: i64,
    pub path: String,
    pub size_bytes: i64,
    pub duration_secs: f64,
    pub format: String,
    pub resolution: String,
    pub preset: String,
    pub status: String,
    pub error: Option<String>,
}

/// Never call this table `exports`.
///
/// `stats::drop_legacy_tables()` drops every table in its `ALL_TABLES` list
/// from `nanamicut.db` on startup, and `exports` is on that list (telemetry
/// moved to `telemetry.db`). `export_history` is deliberately not.
pub const HISTORY_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS export_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    INTEGER NOT NULL,
    path          TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    duration_secs REAL    NOT NULL DEFAULT 0,
    format        TEXT NOT NULL,
    resolution    TEXT NOT NULL,
    preset        TEXT NOT NULL DEFAULT 'custom',
    status        TEXT NOT NULL,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_history_created_at
    ON export_history (created_at DESC, id DESC);
";

/// Keep the panel fast and the database small. A row is a few hundred bytes,
/// so 500 rows is well under 1 MB.
const HISTORY_KEEP: i64 = 500;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the project DB through the existing helper, which already sets WAL,
/// `busy_timeout`, and the bounded page cache. Adding the table here (instead
/// of changing `transcript::init_schema`) keeps the change local and is
/// idempotent.
fn open_history(db_path: Option<&str>) -> Result<Connection, String> {
    let Some(path) = db_path else {
        return Err("no export-history database path".to_string());
    };
    if path.trim().is_empty() {
        return Err("empty export-history database path".to_string());
    }
    let conn = crate::transcript::open_db(Path::new(path))?;
    conn.execute_batch(HISTORY_SCHEMA)
        .map_err(|e| format!("could not init export history schema: {e}"))?;
    Ok(conn)
}

/// Best-effort write. A failed history insert must never fail an export, so
/// callers log the error and carry on.
#[allow(clippy::too_many_arguments)]
pub fn record(
    db_path: Option<&str>,
    path: &str,
    size_bytes: i64,
    duration_secs: f64,
    format: &str,
    resolution: &str,
    preset: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_history(db_path)?;
    conn.execute(
        "INSERT INTO export_history
             (created_at, path, size_bytes, duration_secs, format, resolution, preset, status, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            now_ms(),
            path,
            size_bytes,
            duration_secs,
            format,
            resolution,
            preset,
            status,
            error
        ],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM export_history WHERE id NOT IN
            (SELECT id FROM export_history ORDER BY created_at DESC, id DESC LIMIT ?1)",
        [HISTORY_KEEP],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Newest first — the panel only ever wants the tail of the list.
pub fn list(db_path: &str, limit: i64) -> Result<Vec<ExportHistoryRow>, String> {
    let conn = open_history(Some(db_path))?;
    let limit = limit.clamp(1, HISTORY_KEEP);
    let mut stmt = conn
        .prepare(
            "SELECT id, created_at, path, size_bytes, duration_secs,
                    format, resolution, preset, status, error
             FROM export_history
             ORDER BY created_at DESC, id DESC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |row| {
            Ok(ExportHistoryRow {
                id: row.get(0)?,
                created_at: row.get(1)?,
                path: row.get(2)?,
                size_bytes: row.get(3)?,
                duration_secs: row.get(4)?,
                format: row.get(5)?,
                resolution: row.get(6)?,
                preset: row.get(7)?,
                status: row.get(8)?,
                error: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Delete rows only. Never touch the exported files themselves.
pub fn clear(db_path: &str) -> Result<u32, String> {
    let conn = open_history(Some(db_path))?;
    conn.execute("DELETE FROM export_history", [])
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

/// A bare file name lands in Downloads, exactly like `export::run_export`.
/// Keeping the rule here means preflight and history look at the same path the
/// engine will actually write.
pub fn resolve_output(output: &str, downloads: Option<&Path>) -> PathBuf {
    let path = PathBuf::from(output);
    if path.parent().is_none_or(|p| p.as_os_str().is_empty()) {
        if let Some(dir) = downloads {
            return dir.join(path);
        }
    }
    path
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    pub free_bytes: u64,
    pub exists: bool,
    pub ok: bool,
    pub reason: Option<String>,
}

/// Pure part of preflight — table-driven and unit-tested.
///
/// Peak disk use is pieces + final output, so the requirement is roughly twice
/// the estimate plus a small floor. A zero estimate means "unknown": do not
/// block an export on a number we could not compute.
pub fn decide(
    free_bytes: u64,
    estimated_bytes: u64,
    exists: bool,
    allow_overwrite: bool,
) -> PreflightResult {
    const FLOOR: u64 = 64 * 1024 * 1024;
    let required = estimated_bytes
        .saturating_mul(2)
        .saturating_add(FLOOR);
    let enough = estimated_bytes == 0 || free_bytes >= required;
    let ok = enough && (!exists || allow_overwrite);
    let reason = if exists && !allow_overwrite {
        Some("exists")
    } else if !enough {
        Some("low-space")
    } else {
        None
    };
    PreflightResult {
        free_bytes,
        exists,
        ok,
        reason: reason.map(str::to_string),
    }
}

/// What the installed engine understands. The UI disables the controls whose
/// flag is false, so this must not claim a feature that is not wired up.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCapabilities {
    pub fps: bool,
    pub codec: bool,
    pub container: bool,
    pub include_audio: bool,
    pub quality: bool,
    pub preflight: bool,
    pub history: bool,
    pub logs: bool,
}

impl Default for ExportCapabilities {
    fn default() -> Self {
        Self {
            fps: true,
            codec: true,
            container: true,
            include_audio: true,
            quality: true,
            preflight: true,
            history: true,
            logs: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(HISTORY_SCHEMA).unwrap();
        conn
    }

    #[test]
    fn history_round_trips_and_orders_newest_first() {
        let conn = mem_db();
        for (i, status) in [(1, "done"), (2, "failed")].into_iter() {
            conn.execute(
                "INSERT INTO export_history
                    (created_at, path, format, resolution, preset, status)
                 VALUES (?1, ?2, 'video', '1080p', 'youtube', ?3)",
                params![i, format!("C:\\out\\{i}.mp4"), status],
            )
            .unwrap();
        }
        let mut stmt = conn
            .prepare("SELECT status FROM export_history ORDER BY created_at DESC")
            .unwrap();
        let got: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(got, ["failed", "done"]);
    }

    #[test]
    fn preflight_needs_twice_the_estimate() {
        let r = decide(300 * 1024 * 1024, 100 * 1024 * 1024, false, false);
        assert!(r.ok, "2x estimate + 64 MB floor fits in 300 MB");
        assert_eq!(r.reason, None);

        let r = decide(150 * 1024 * 1024, 100 * 1024 * 1024, false, false);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("low-space"));
    }

    #[test]
    fn overwrite_only_passes_when_allowed() {
        let r = decide(1024, 0, true, false);
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("exists"));
        let r = decide(1024, 0, true, true);
        assert!(r.ok);
        assert_eq!(r.reason, None);
    }

    #[test]
    fn unknown_estimate_does_not_block() {
        let r = decide(1, 0, false, false);
        assert!(r.ok);
    }

    #[test]
    fn bare_output_anchors_to_downloads() {
        assert_eq!(
            resolve_output("clip.mp4", Some(Path::new("C:\\Users\\me\\Downloads"))),
            PathBuf::from("C:\\Users\\me\\Downloads\\clip.mp4")
        );
        assert_eq!(
            resolve_output("D:\\out\\clip.mp4", Some(Path::new("C:\\Downloads"))),
            PathBuf::from("D:\\out\\clip.mp4")
        );
    }
}
