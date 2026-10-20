//! Disk-backed transcript store (Chunk 2, step 4).
//!
//! Transcript lines and cut decisions live in SQLite, never in the heap. This
//! module owns the schema and the CRUD helpers; Tauri commands in `lib.rs` are
//! thin wrappers.

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// One word with its own timing, straight out of Whisper's `words` array.
///
/// This is what makes a split *cut the text* as well as the timeline: cutting
/// "I LOVE U" after 4 s can then yield "I" and "LOVE U" instead of two
/// identical rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Word {
    pub word: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLine {
    pub id: String,
    pub start_secs: f64,
    pub end_secs: f64,
    pub text: String,
    #[serde(default = "default_keep")]
    pub keep: bool,
    #[serde(default = "default_flag")]
    pub flag: String,
    /// The pre-autocorrect Whisper text, set only when autocorrect actually
    /// changed the line. Empty means "never corrected" — which is different
    /// from "corrected and came back identical", and the UI relies on that
    /// to decide whether a line is worth flagging as fixed.
    #[serde(default)]
    pub original_text: String,
    /// Word-level timings, when the engine produced them. Stored as a JSON blob
    /// in one column; absent means "no word alignment for this line".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub duration_secs: f64,
    pub last_opened: i64,
}

/// A project the user removed from the dashboard list.
///
/// The **video file is never touched** — only the app's record of it moves into
/// the bin, so a restore brings the project back exactly as it was.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub name: String,
    pub source_path: String,
    pub duration_secs: f64,
    /// Unix seconds — when the project was moved to the bin.
    pub deleted_at: i64,
}

fn default_keep() -> bool {
    true
}
fn default_flag() -> String {
    "none".to_string()
}

/* --------------------------------------------------------------- paths */

/**
 * Collapse a path to the one spelling that always identifies the same file.
 *
 * The transcript table is keyed by `source_path`, so the *string* has to be
 * stable — the file being the same is not enough. A path that was built from
 * the working directory (`…/Clipchamp_Bunny/../resource_Clipchamp/clip.mp4`)
 * spells a different string depending on where the app was launched from, and
 * that is exactly what used to happen: launching from the taskbar missed the
 * SQLite cache, re-transcribed the whole video and paid for the API again.
 *
 * The rules:
 *   * relative → resolved against the working directory,
 *   * `..` and `.` → collapsed,
 *   * symlinks → resolved,
 *   * Windows' `\\?\` verbatim prefix → removed (it breaks asset URLs).
 */
pub fn canonical_path(path: &str) -> String {
    let raw = Path::new(path);
    let absolute = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(raw)
    };

    let resolved = std::fs::canonicalize(&absolute).unwrap_or_else(|_| lexical_clean(&absolute));
    strip_verbatim(resolved.to_string_lossy().into_owned())
}

/// Collapse `.` and `..` without touching the filesystem.
fn lexical_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // `..` at the root has nothing to pop — keep it, or the path
                // would climb above the drive.
                if !out.pop() {
                    out.push(comp.as_os_str());
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Windows canonicalisation hands back a `\\?\` verbatim path. The webview
/// cannot stream from that, so the prefix is removed again.
fn strip_verbatim(path: String) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    path
}

/// Every distinct `source_path` stored in a table.
fn distinct_paths(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("SELECT DISTINCT source_path FROM {table}");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("could not prepare {table} path scan: {e}"))?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| format!("could not query {table} paths: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("could not read {table} path: {e}"))?);
    }
    Ok(out)
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS transcripts (
    source_path    TEXT NOT NULL,
    id             TEXT NOT NULL,
    start_secs     REAL NOT NULL,
    end_secs       REAL NOT NULL,
    text           TEXT NOT NULL,
    keep           INTEGER NOT NULL,
    flag           TEXT NOT NULL,
    original_text  TEXT NOT NULL DEFAULT '',
    words          TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (source_path, id)
);
";

const PROJECTS_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS projects (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    source_path   TEXT NOT NULL UNIQUE,
    duration_secs REAL NOT NULL,
    last_opened   INTEGER NOT NULL
);
";

/// The dashboard's bin.
///
/// A row here is a project the user removed from the list — **its video file is
/// untouched**. The trash only holds the app's own record of it, so a restore
/// brings the project back exactly as it was.
const TRASH_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS trash (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    source_path   TEXT NOT NULL UNIQUE,
    duration_secs REAL NOT NULL,
    deleted_at    INTEGER NOT NULL
);
";

pub fn open_db(path: &std::path::Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create db dir {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(path)
        .map_err(|e| format!("could not open transcript db {}: {e}", path.display()))?;
    init_schema(&conn)?;
    Ok(conn)
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("could not init transcript schema: {e}"))?;
    migrate_transcripts(conn)?;
    conn.execute_batch(PROJECTS_SCHEMA)
        .map_err(|e| format!("could not init projects schema: {e}"))?;
    conn.execute_batch(TRASH_SCHEMA)
        .map_err(|e| format!("could not init trash schema: {e}"))?;
    migrate_paths(conn)
}

/// Fold older, working-directory-dependent paths onto the canonical spelling.
///
/// A database written before this change may hold
/// `…/Clipchamp_Bunny/../resource_Clipchamp/clip.mp4` as the key for a video
/// that is also reachable as `…/resource_Clipchamp/clip.mp4`. Both spell the
/// same file, but SQLite sees two different rows — so the second launch (from
/// a different folder) found an empty table and re-ran the whole pipeline.
///
/// When both spellings exist the canonical copy wins: it is the one a proper
/// launch wrote, and therefore the fresher one.
fn migrate_paths(conn: &Connection) -> Result<(), String> {
    for old in distinct_paths(conn, "transcripts")? {
        let new = canonical_path(&old);
        if new == old {
            continue;
        }
        // Drop the stale rows whose id is already present under the canonical
        // key — the primary key would otherwise reject the move.
        conn.execute(
            "DELETE FROM transcripts
              WHERE source_path = ?1
                AND id IN (SELECT id FROM transcripts WHERE source_path = ?2)",
            params![old, new],
        )
        .map_err(|e| format!("could not drop duplicate transcript rows: {e}"))?;
        conn.execute(
            "UPDATE transcripts SET source_path = ?1 WHERE source_path = ?2",
            params![new, old],
        )
        .map_err(|e| format!("could not canonicalise transcript paths: {e}"))?;
    }

    for old in distinct_paths(conn, "projects")? {
        let new = canonical_path(&old);
        if new == old {
            continue;
        }
        // `projects.source_path` is UNIQUE, so a canonical row has to be
        // removed before the stale one can move onto its key.
        conn.execute(
            "DELETE FROM projects
              WHERE source_path = ?1
                AND EXISTS (SELECT 1 FROM projects WHERE source_path = ?2)",
            params![old, new],
        )
        .map_err(|e| format!("could not drop duplicate project rows: {e}"))?;
        conn.execute(
            "UPDATE projects SET source_path = ?1 WHERE source_path = ?2",
            params![new, old],
        )
        .map_err(|e| format!("could not canonicalise project paths: {e}"))?;
    }
    Ok(())
}

/// Bring an older transcripts table up to the current columns.
///
/// `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
/// database written before autocorrect would otherwise fail every query with
/// "no such column: original_text" — and the user has already transcribed
/// videos into theirs. Adding the column is safe: it defaults to empty, which
/// is exactly what an uncorrected line should read as.
fn migrate_transcripts(conn: &Connection) -> Result<(), String> {
    if !column_exists(conn, "transcripts", "original_text")? {
        conn.execute_batch("ALTER TABLE transcripts ADD COLUMN original_text TEXT NOT NULL DEFAULT ''")
            .map_err(|e| format!("could not add transcripts.original_text: {e}"))?;
    }
    // Word-level timings, same reasoning: a missing column would break every
    // query on a database written before this change.
    if !column_exists(conn, "transcripts", "words")? {
        conn.execute_batch("ALTER TABLE transcripts ADD COLUMN words TEXT NOT NULL DEFAULT ''")
            .map_err(|e| format!("could not add transcripts.words: {e}"))?;
    }
    Ok(())
}

/// Reports whether a column exists, via PRAGMA table_info.
///
/// PRAGMA does not accept a bound parameter, so the identifier is formatted
/// into the statement. Both arguments come from string literals in this file —
/// never from user input — which is what makes that safe here.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({table})");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("could not inspect {table}: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("could not read {table} columns: {e}"))?;

    while let Some(row) = rows
        .next()
        .map_err(|e| format!("could not read {table} columns: {e}"))?
    {
        let name: String = row
            .get(1)
            .map_err(|e| format!("could not read {table} column name: {e}"))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn save_transcript(
    conn: &Connection,
    source_path: &str,
    lines: &[TranscriptLine],
) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;

    tx.execute(
        "DELETE FROM transcripts WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not clear old transcript: {e}"))?;

    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO transcripts (source_path, id, start_secs, end_secs, text, keep, flag, original_text, words)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| format!("could not prepare insert: {e}"))?;
        for line in lines {
            let words_json = match &line.words {
                Some(w) if !w.is_empty() => serde_json::to_string(w)
                    .map_err(|e| format!("could not encode words: {e}"))?,
                _ => String::new(),
            };
            stmt.execute(params![
                source_path,
                line.id,
                line.start_secs,
                line.end_secs,
                line.text,
                if line.keep { 1 } else { 0 },
                line.flag,
                line.original_text,
                words_json,
            ])
            .map_err(|e| format!("could not insert transcript line: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("could not commit transcript: {e}"))?;
    Ok(())
}

pub fn load_transcript(
    conn: &Connection,
    source_path: &str,
) -> Result<Vec<TranscriptLine>, String> {
    let source_path = canonical_path(source_path);
    let mut stmt = conn
        .prepare(
            "SELECT id, start_secs, end_secs, text, keep, flag, original_text, words
             FROM transcripts WHERE source_path = ?1
             ORDER BY start_secs ASC",
        )
        .map_err(|e| format!("could not prepare select: {e}"))?;

    let rows = stmt
        .query_map(params![source_path], |r| {
            let words_json = r.get::<_, Option<String>>(7)?.unwrap_or_default();
            let words = if words_json.is_empty() {
                None
            } else {
                // A malformed blob must not sink the whole transcript.
                serde_json::from_str::<Vec<Word>>(&words_json).ok()
            };
            Ok(TranscriptLine {
                id: r.get(0)?,
                start_secs: r.get(1)?,
                end_secs: r.get(2)?,
                text: r.get(3)?,
                keep: r.get::<_, i64>(4)? != 0,
                flag: r.get(5)?,
                // COALESCE guards a database that predates the migration in
                // some other way; a NULL here would fail the String read.
                original_text: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                words,
            })
        })
        .map_err(|e| format!("could not query transcript: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("could not read transcript row: {e}"))?);
    }
    Ok(out)
}

pub fn set_keep(conn: &Connection, source_path: &str, id: &str, keep: bool) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "UPDATE transcripts SET keep = ?1 WHERE source_path = ?2 AND id = ?3",
        params![if keep { 1 } else { 0 }, source_path, id],
    )
    .map_err(|e| format!("could not update keep: {e}"))?;
    Ok(())
}

pub fn set_flag(conn: &Connection, source_path: &str, id: &str, flag: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "UPDATE transcripts SET flag = ?1 WHERE source_path = ?2 AND id = ?3",
        params![flag, source_path, id],
    )
    .map_err(|e| format!("could not update flag: {e}"))?;
    Ok(())
}

pub fn delete_transcript(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "DELETE FROM transcripts WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not delete transcript: {e}"))?;
    Ok(())
}

/// Upsert a project row. Called when a video is imported into the editor.
pub fn save_project(
    conn: &Connection,
    id: &str,
    name: &str,
    source_path: &str,
    duration_secs: f64,
    last_opened: i64,
) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "INSERT INTO projects (id, name, source_path, duration_secs, last_opened)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(source_path) DO UPDATE SET
           name = excluded.name,
           duration_secs = excluded.duration_secs,
           last_opened = excluded.last_opened",
        params![id, name, source_path, duration_secs, last_opened],
    )
    .map_err(|e| format!("could not save project: {e}"))?;
    Ok(())
}

/// All projects, most recently opened first.
pub fn load_projects(conn: &Connection) -> Result<Vec<Project>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, source_path, duration_secs, last_opened
             FROM projects ORDER BY last_opened DESC",
        )
        .map_err(|e| format!("could not prepare projects select: {e}"))?;

    let rows = stmt
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                source_path: r.get(2)?,
                duration_secs: r.get(3)?,
                last_opened: r.get(4)?,
            })
        })
        .map_err(|e| format!("could not query projects: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("could not read project row: {e}"))?);
    }
    Ok(out)
}

/// The source path of the most recently opened project whose file is still there.
///
/// This is what makes "open the app" mean "open *my* last video, with its real
/// transcript" instead of "show the demo recording". Projects are ordered by
/// `last_opened`, and a project whose file has since been moved or deleted is
/// skipped rather than reported as an error.
pub fn resume_project(conn: &Connection) -> Result<Option<String>, String> {
    for project in load_projects(conn)? {
        if Path::new(&project.source_path).exists() {
            return Ok(Some(project.source_path));
        }
    }
    Ok(None)
}

/// Mark a project as opened now (updates `last_opened` to current unix seconds).
pub fn update_project_opened(
    conn: &Connection,
    source_path: &str,
    last_opened: i64,
) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "UPDATE projects SET last_opened = ?1 WHERE source_path = ?2",
        params![last_opened, source_path],
    )
    .map_err(|e| format!("could not update project opened: {e}"))?;
    Ok(())
}

pub fn delete_project(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "DELETE FROM projects WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not delete project: {e}"))?;
    Ok(())
}

/* ------------------------------------------------------------------- trash */

/// Unix seconds, right now.
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Move a project out of the list and into the bin.
///
/// The row is **copied** into `trash` and then removed from `projects`, so the
/// transcript that belongs to it stays in SQLite exactly where it was — a
/// restore is instant and needs no re-transcription.
pub fn trash_project(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    let now = now_unix();
    conn.execute(
        "INSERT INTO trash (id, name, source_path, duration_secs, deleted_at)
           SELECT id, name, source_path, duration_secs, ?1
             FROM projects
            WHERE source_path = ?2
         ON CONFLICT(source_path) DO UPDATE SET
           name = excluded.name,
           duration_secs = excluded.duration_secs,
           deleted_at = excluded.deleted_at",
        params![now, source_path],
    )
    .map_err(|e| format!("could not move project to trash: {e}"))?;
    conn.execute(
        "DELETE FROM projects WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not remove project from the list: {e}"))?;
    Ok(())
}

/// Bring a project back from the bin.
pub fn restore_project(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "INSERT INTO projects (id, name, source_path, duration_secs, last_opened)
           SELECT id, name, source_path, duration_secs, ?1
             FROM trash
            WHERE source_path = ?2
         ON CONFLICT(source_path) DO UPDATE SET
           name = excluded.name,
           duration_secs = excluded.duration_secs,
           last_opened = excluded.last_opened",
        params![now_unix(), source_path],
    )
    .map_err(|e| format!("could not restore project: {e}"))?;
    conn.execute(
        "DELETE FROM trash WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not clear project from trash: {e}"))?;
    Ok(())
}

/// Everything currently in the bin, newest first.
pub fn load_trash(conn: &Connection) -> Result<Vec<TrashItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, source_path, duration_secs, deleted_at
             FROM trash ORDER BY deleted_at DESC",
        )
        .map_err(|e| format!("could not prepare trash select: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TrashItem {
                id: r.get(0)?,
                name: r.get(1)?,
                source_path: r.get(2)?,
                duration_secs: r.get(3)?,
                deleted_at: r.get(4)?,
            })
        })
        .map_err(|e| format!("could not query trash: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("could not read trash row: {e}"))?);
    }
    Ok(out)
}

/// Drop a project from the bin for good.
///
/// **Only the app's record is deleted** — the user's video file is left alone
/// on disk, because the app never owns somebody else's footage.
pub fn purge_trash(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    conn.execute(
        "DELETE FROM trash WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not empty trash: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    /// A line with every field at its zero value, for tests that only care
    /// about one field.
    fn line(id: &str, text: &str) -> TranscriptLine {
        TranscriptLine {
            id: id.into(),
            start_secs: 0.0,
            end_secs: 1.0,
            text: text.into(),
            keep: true,
            flag: "none".into(),
            original_text: String::new(),
            words: None,
        }
    }

    #[test]
    fn schema_and_round_trip() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let lines = vec![
            TranscriptLine {
                id: "1".into(),
                start_secs: 0.0,
                end_secs: 1.5,
                text: "hello".into(),
                keep: true,
                flag: "none".into(),
                original_text: String::new(),
                words: None,
            },
            TranscriptLine {
                id: "2".into(),
                start_secs: 1.5,
                end_secs: 3.0,
                text: "uhh".into(),
                keep: false,
                flag: "fumble".into(),
                original_text: String::new(),
                words: None,
            },
        ];
        save_transcript(&conn, "/v.mp4", &lines).unwrap();
        let loaded = load_transcript(&conn, "/v.mp4").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].text, "hello");
        assert!(!loaded[1].keep);
        assert_eq!(loaded[1].flag, "fumble");
    }

    #[test]
    fn original_text_round_trips() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let mut corrected = line("1", "JavaScript ek language hai.");
        corrected.original_text = "javas cript ek language hai".into();
        let untouched = line("2", "ye theek hai");

        save_transcript(&conn, "/v.mp4", &[corrected, untouched]).unwrap();
        let loaded = load_transcript(&conn, "/v.mp4").unwrap();

        assert_eq!(loaded[0].original_text, "javas cript ek language hai");
        assert_eq!(loaded[0].text, "JavaScript ek language hai.");
        // An uncorrected line must read as empty, not as a copy of its own
        // text — the UI uses that emptiness to decide what to mark as fixed.
        assert_eq!(loaded[1].original_text, "");
    }

    #[test]
    fn migration_adds_original_text_to_an_existing_table() {
        let conn = mem_conn();
        // Exactly the table shape from before autocorrect shipped.
        conn.execute_batch(
            "CREATE TABLE transcripts (
                 source_path TEXT NOT NULL,
                 id          TEXT NOT NULL,
                 start_secs  REAL NOT NULL,
                 end_secs    REAL NOT NULL,
                 text        TEXT NOT NULL,
                 keep        INTEGER NOT NULL,
                 flag        TEXT NOT NULL,
                 PRIMARY KEY (source_path, id)
             );
             INSERT INTO transcripts VALUES ('/old.mp4', '1', 0.0, 2.0, 'purana line', 1, 'none');",
        )
        .unwrap();

        init_schema(&conn).unwrap();

        let loaded = load_transcript(&conn, "/old.mp4").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "purana line");
        assert_eq!(loaded[0].original_text, "");

        // Running it twice must not fail on a duplicate column.
        init_schema(&conn).unwrap();
    }

    #[test]
    fn set_keep_updates_row() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let lines = vec![line("1", "hi")];
        save_transcript(&conn, "/v.mp4", &lines).unwrap();
        set_keep(&conn, "/v.mp4", "1", false).unwrap();
        let loaded = load_transcript(&conn, "/v.mp4").unwrap();
        assert!(!loaded[0].keep);
    }

    #[test]
    fn delete_clears() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let lines = vec![line("1", "hi")];
        save_transcript(&conn, "/v.mp4", &lines).unwrap();
        delete_transcript(&conn, "/v.mp4").unwrap();
        assert!(load_transcript(&conn, "/v.mp4").unwrap().is_empty());
    }

    /* ------------------------------------------------------ path handling */

    #[test]
    fn canonical_path_collapses_dot_dot() {
        let dir = std::env::temp_dir().join("t9editorlit-canon-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();

        let direct = canonical_path(&file.to_string_lossy());
        let roundabout = canonical_path(&dir.join("..").join(dir.file_name().unwrap()).join("clip.mp4").to_string_lossy());

        assert_eq!(direct, roundabout);
        assert!(!direct.contains(".."));
    }

    #[test]
    fn canonical_path_is_stable_for_a_missing_file() {
        // A file that does not exist yet still gets a stable, absolute key.
        let missing = std::env::temp_dir().join("t9editorlit-not-here").join("x.mp4");
        let a = canonical_path(&missing.to_string_lossy());
        let b = canonical_path(&missing.to_string_lossy());
        assert_eq!(a, b);
        assert!(std::path::Path::new(&a).is_absolute());
    }

    #[test]
    fn one_file_two_spellings_share_one_transcript_row() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let dir = std::env::temp_dir().join("t9editorlit-two-spellings");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();

        let direct = file.to_string_lossy().into_owned();
        let roundabout = dir
            .join("..")
            .join(dir.file_name().unwrap())
            .join("clip.mp4")
            .to_string_lossy()
            .into_owned();

        save_transcript(&conn, &direct, &[line("1", "hello")]).unwrap();
        // The second spelling has to find the very same row.
        let loaded = load_transcript(&conn, &roundabout).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "hello");
    }

    #[test]
    fn migration_folds_an_old_spelling_onto_the_canonical_one() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let dir = std::env::temp_dir().join("t9editorlit-migrate-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let canonical = canonical_path(&file.to_string_lossy());

        // Write a row the way the old code did: keyed by a spelled-out path.
        let old = dir
            .join("..")
            .join(dir.file_name().unwrap())
            .join("clip.mp4")
            .to_string_lossy()
            .into_owned();
        conn.execute(
            "INSERT INTO transcripts (source_path, id, start_secs, end_secs, text, keep, flag, original_text, words)
             VALUES (?1, '1', 0.0, 1.0, 'purana line', 1, 'none', '', '')",
            params![old],
        )
        .unwrap();

        // Opening the database again runs the migration.
        init_schema(&conn).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM transcripts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);

        let loaded = load_transcript(&conn, &canonical).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].text, "purana line");
    }

    #[test]
    fn resume_project_skips_a_project_whose_file_is_gone() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        let dir = std::env::temp_dir().join("t9editorlit-resume-test");
        std::fs::create_dir_all(&dir).unwrap();
        let alive = dir.join("alive.mp4");
        std::fs::write(&alive, b"x").unwrap();

        // The most recent project points at a file that is not there.
        save_project(&conn, "p2", "Gone", "/definitely/not/here.mp4", 10.0, now).unwrap();
        save_project(
            &conn,
            "p1",
            "Alive",
            &alive.to_string_lossy(),
            10.0,
            now - 100,
        )
        .unwrap();

        assert_eq!(resume_project(&conn).unwrap(), Some(canonical_path(&alive.to_string_lossy())));
    }

    #[test]
    fn save_and_load_project() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        save_project(&conn, "p1", "My Video", "/v.mp4", 120.5, now).unwrap();
        let projects = load_projects(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "My Video");
        // The stored path is the canonical one, so the same file always lands
        // on the same row no matter how it was spelled on the way in.
        assert_eq!(projects[0].source_path, canonical_path("/v.mp4"));
        assert!((projects[0].duration_secs - 120.5).abs() < f64::EPSILON);
        assert_eq!(projects[0].last_opened, now);
    }

    #[test]
    fn save_project_upserts_on_conflict() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        save_project(&conn, "p1", "First Name", "/v.mp4", 60.0, now).unwrap();
        save_project(&conn, "p1", "Updated Name", "/v.mp4", 90.0, now + 100).unwrap();
        let projects = load_projects(&conn).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Updated Name");
        assert!((projects[0].duration_secs - 90.0).abs() < f64::EPSILON);
        assert_eq!(projects[0].last_opened, now + 100);
    }

    #[test]
    fn load_projects_returns_most_recent_first() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        save_project(&conn, "p1", "Older", "/old.mp4", 30.0, now).unwrap();
        save_project(&conn, "p2", "Newer", "/new.mp4", 45.0, now + 500).unwrap();
        let projects = load_projects(&conn).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].name, "Newer");
        assert_eq!(projects[1].name, "Older");
    }

    #[test]
    fn update_project_opened_changes_timestamp() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        save_project(&conn, "p1", "Video", "/v.mp4", 60.0, now).unwrap();
        update_project_opened(&conn, "/v.mp4", now + 999).unwrap();
        let projects = load_projects(&conn).unwrap();
        assert_eq!(projects[0].last_opened, now + 999);
    }

    #[test]
    fn trash_round_trip_moves_the_row_without_losing_it() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        save_project(&conn, "p1", "Video", "/v.mp4", 60.0, 100).unwrap();

        trash_project(&conn, "/v.mp4").unwrap();
        assert!(load_projects(&conn).unwrap().is_empty());
        let bin = load_trash(&conn).unwrap();
        assert_eq!(bin.len(), 1);
        assert_eq!(bin[0].name, "Video");
        assert_eq!(bin[0].source_path, canonical_path("/v.mp4"));

        restore_project(&conn, "/v.mp4").unwrap();
        assert!(load_trash(&conn).unwrap().is_empty());
        assert_eq!(load_projects(&conn).unwrap().len(), 1);
    }

    #[test]
    fn purge_trash_forgets_the_record_but_keeps_the_project_row_out() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        save_project(&conn, "p1", "Video", "/v.mp4", 60.0, 100).unwrap();
        trash_project(&conn, "/v.mp4").unwrap();
        purge_trash(&conn, "/v.mp4").unwrap();
        assert!(load_trash(&conn).unwrap().is_empty());
        assert!(load_projects(&conn).unwrap().is_empty());
    }
}
