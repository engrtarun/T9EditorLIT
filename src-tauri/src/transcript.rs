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

/// Covering indexes for the two ORDER BYs the UI issues on every dashboard
/// load. Without the `last_opened` one every load sorts the whole table.
const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects (last_opened);
CREATE INDEX IF NOT EXISTS idx_trash_deleted_at     ON trash (deleted_at);
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

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

static INITIALIZED_DBS: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

pub fn open_db(path: &std::path::Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create db dir {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(path)
        .map_err(|e| format!("could not open transcript db {}: {e}", path.display()))?;

    // WAL mode + NORMAL synchronous: concurrent reads never block writes,
    // and writes append sequentially to WAL without expensive disk locks.
    //
    // The rest are bounded-RAM choices for the 8 GB box: a 4 MB page cache,
    // temp tables in memory (the diff save uses one), and a 4 MB WAL cap so
    // a big transaction wave cannot balloon the file.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -4000;
         PRAGMA journal_size_limit = 4194304;",
    )
    .map_err(|e| format!("could not configure sqlite pragmas: {e}"))?;

    // A per-command open happens dozens of times a session. The schema init
    // runs once per process, so it is remembered by **both** spellings of the
    // path — the raw one callers pass and the canonical one — and the
    // (syscall-heavy) canonicalize only happens on the very first miss.
    let already_init = {
        let mut guard = INITIALIZED_DBS.lock().unwrap_or_else(|e| e.into_inner());
        let set = guard.get_or_insert_with(HashSet::new);
        if set.contains(path) {
            true
        } else {
            let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
            if set.contains(&canonical) {
                true
            } else {
                set.insert(canonical);
                set.insert(path.to_path_buf());
                false
            }
        }
    };

    if !already_init {
        init_schema(&conn)?;
    }
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
    conn.execute_batch(INDEXES)
        .map_err(|e| format!("could not init indexes: {e}"))?;
    // `PRAGMA optimize` updates the query planner's statistics from what this
    // session actually did — once per process, cheap, no ANALYZE scan needed.
    let _ = conn.execute_batch("PRAGMA optimize;");
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
        conn.execute_batch(
            "ALTER TABLE transcripts ADD COLUMN original_text TEXT NOT NULL DEFAULT ''",
        )
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
pub(crate) fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
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

/// Replace the stored transcript for a source — **diff-style**.
///
/// Autosave fires every 750 ms while the user edits, and it used to reroll the
/// *whole* table (DELETE all + INSERT all, words JSON included). On a
/// three-hour interview that is thousands of lines rewritten every second of
/// edit time, for a change of one line. This version:
///
/// * loads the stored rows once,
/// * upserts only the lines that actually differ (including `words` — an
///   absent `words` never erases the stored timings),
/// * deletes the ids that no longer exist, in the same transaction.
///
/// Everything lands atomically, and the return value is how many rows the
/// engine wrote — the progress trail uses it to prove a save was not a no-op.
pub fn save_transcript(
    conn: &Connection,
    source_path: &str,
    lines: &[TranscriptLine],
) -> Result<u32, String> {
    let source_path = canonical_path(source_path);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;

    // The stored state, compared field by field below.
    struct Stored {
        start_secs: f64,
        end_secs: f64,
        text: String,
        keep: i64,
        flag: String,
        original_text: String,
        words: String,
    }
    let mut existing: HashMap<String, Stored> = HashMap::with_capacity(lines.len());
    {
        let mut stmt = tx
            .prepare(
                "SELECT id, start_secs, end_secs, text, keep, flag, original_text, words
                 FROM transcripts WHERE source_path = ?1",
            )
            .map_err(|e| format!("could not prepare transcript read: {e}"))?;
        let mut rows = stmt
            .query(params![source_path])
            .map_err(|e| format!("could not read the stored transcript: {e}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| format!("could not read a transcript row: {e}"))?
        {
            let id: String = row
                .get(0)
                .map_err(|e| format!("could not read a transcript id: {e}"))?;
            let get = |i: usize| -> Result<String, String> {
                row.get::<_, Option<String>>(i)
                    .map(|v| v.unwrap_or_default())
                    .map_err(|e| e.to_string())
            };
            existing.insert(
                id,
                Stored {
                    start_secs: row.get(1).map_err(|e| e.to_string())?,
                    end_secs: row.get(2).map_err(|e| e.to_string())?,
                    text: get(3)?,
                    keep: row.get::<_, Option<i64>>(4).map_err(|e| e.to_string())?.unwrap_or(1),
                    flag: get(5)?,
                    original_text: get(6)?,
                    words: get(7)?,
                },
            );
        }
    }

    // Ids the caller no longer provides are gone. One DELETE per stale id is
    // fine after a split/merge — the count is at most a handful, and it keeps
    // the statement cache warm instead of building a giant IN (...) list.
    let provided: std::collections::HashSet<&str> =
        lines.iter().map(|l| l.id.as_str()).collect();
    let mut stale: Vec<&String> = existing
        .keys()
        .filter(|id| !provided.contains(id.as_str()))
        .collect();
    stale.sort_unstable();
    {
        let mut stmt = tx
            .prepare("DELETE FROM transcripts WHERE source_path = ?1 AND id = ?2")
            .map_err(|e| format!("could not prepare transcript delete: {e}"))?;
        for id in &stale {
            stmt.execute(params![source_path, *id])
                .map_err(|e| format!("could not delete a removed line: {e}"))?;
        }
    }

    // The words column: an explicit word list replaces it, an absent one must
    // **not** erase the stored timings (see the module doc).
    let words_of = |line: &TranscriptLine, current: Option<&String>| -> String {
        match &line.words {
            Some(w) if !w.is_empty() => serde_json::to_string(w).unwrap_or_default(),
            _ => current.cloned().unwrap_or_default(),
        }
    };

    // Upsert only the rows that actually differ from what is stored. On a
    // typical autosave tick that is zero or one line — not the whole table.
    let mut changed: u32 = stale.len() as u32;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO transcripts (source_path, id, start_secs, end_secs, text, keep, flag, original_text, words)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(source_path, id) DO UPDATE SET
                   start_secs = excluded.start_secs,
                   end_secs = excluded.end_secs,
                   text = excluded.text,
                   keep = excluded.keep,
                   flag = excluded.flag,
                   original_text = excluded.original_text,
                   words = excluded.words",
            )
            .map_err(|e| format!("could not prepare transcript upsert: {e}"))?;
        for line in lines {
            let current = existing.get(&line.id);
            let words = words_of(line, current.map(|s| &s.words));
            let differs = match current {
                None => true,
                Some(s) => {
                    s.start_secs != line.start_secs
                        || s.end_secs != line.end_secs
                        || s.text != line.text
                        || s.keep != i64::from(line.keep)
                        || s.flag != line.flag
                        || s.original_text != line.original_text
                        || s.words != words
                }
            };
            if !differs {
                continue;
            }
            changed += 1;
            stmt.execute(params![
                source_path,
                line.id,
                line.start_secs,
                line.end_secs,
                line.text,
                if line.keep { 1 } else { 0 },
                line.flag,
                line.original_text,
                words,
            ])
            .map_err(|e| format!("could not upsert transcript line: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("could not commit transcript: {e}"))?;
    Ok(changed)
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
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;
    tx.execute(
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
    tx.execute(
        "DELETE FROM projects WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not remove project from the list: {e}"))?;
    tx.commit()
        .map_err(|e| format!("could not commit trash move: {e}"))
}

/// Bring a project back from the bin.
pub fn restore_project(conn: &Connection, source_path: &str) -> Result<(), String> {
    let source_path = canonical_path(source_path);
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;
    tx.execute(
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
    tx.execute(
        "DELETE FROM trash WHERE source_path = ?1",
        params![source_path],
    )
    .map_err(|e| format!("could not clear project from trash: {e}"))?;
    tx.commit()
        .map_err(|e| format!("could not commit restore: {e}"))
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

/* ------------------------------------------------------------ purge + sweep */

/// One purged project: where its rows lived and the derived-file key it owned.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgedEntry {
    pub path: String,
    pub cache_key: String,
}

/// The outcome of a purge or an orphan sweep.
///
/// `entries` tells the **command layer** which derived files it may now delete
/// from the disk — this module knows SQLite, not the cache root, so the file
/// deletion deliberately happens one layer up.
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSummary {
    /// Projects that vanished (a row in `projects` or `trash` existed for it).
    pub purged: usize,
    /// Extra dead rows a sweep removed (transcript lines + probe-cache rows).
    pub orphan_rows: usize,
    /// The `cache::source_key`-keyed files the caller can delete.
    pub entries: Vec<PurgedEntry>,
}

/// Does the probe-cache table exist at all?
///
/// Both crates create it next to these tables, but a database only touched by
/// an old build can predate it — and a purge must survive that.
fn media_cache_exists(conn: &Connection) -> bool {
    matches!(
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_cache'",
            [],
            |r| r.get::<_, i64>(0)
        ),
        Ok(1)
    )
}

/// Remove the records of projects — from the list, the bin, their transcript
/// and their probe cache — in **one transaction**.
///
/// The video files themselves are never touched: the app does not own the
/// user's footage. What is fair game are the app's own derived files, and the
/// [`PurgeSummary`] hands the (path, cache key) pairs to the command layer so
/// it can delete `posters/<key>.jpg`, `thumbs/<key>/` and `waveform/<key>.json`.
pub fn purge_projects(conn: &Connection, paths: &[String]) -> Result<PurgeSummary, String> {
    let mut summary = PurgeSummary::default();

    // Canonicalise and dedupe up front — a duplicate path would otherwise be
    // counted (and cleaned) twice.
    let mut unique: Vec<String> = paths
        .iter()
        .map(|p| canonical_path(p))
        .collect::<Vec<_>>();
    unique.sort_unstable();
    unique.dedup();
    if unique.is_empty() {
        return Ok(summary);
    }

    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;

    // The keys must be read *before* the rows vanish, and this read rides the
    // same transaction so it cannot race a concurrent probe.
    if media_cache_exists(&tx) {
        summary.entries = super::media::media_cache_keys(&tx, &unique)
            .unwrap_or_default()
            .into_iter()
            .map(|(path, cache_key)| PurgedEntry { path, cache_key })
            .collect();
    }

    {
        let mut del_transcript = tx
            .prepare("DELETE FROM transcripts WHERE source_path = ?1")
            .map_err(|e| format!("could not prepare transcript delete: {e}"))?;
        let mut del_trash = tx
            .prepare("DELETE FROM trash WHERE source_path = ?1")
            .map_err(|e| format!("could not prepare trash delete: {e}"))?;
        let mut del_project = tx
            .prepare("DELETE FROM projects WHERE source_path = ?1")
            .map_err(|e| format!("could not prepare project delete: {e}"))?;
        let mut del_media = tx
            .prepare("DELETE FROM media_cache WHERE source_path = ?1")
            .map_err(|e| format!("could not prepare media cache delete: {e}"))?;

        for path in &unique {
            // ?1 twice: SQLite allows repeated indexed markers, rusqlite binds
            // the slot once, so one param covers both EXISTS probes.
            let tracked: i64 = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM projects WHERE source_path = ?1)
                      + EXISTS(SELECT 1 FROM trash    WHERE source_path = ?1)",
                    params![path],
                    |r| r.get(0),
                )
                .map_err(|e| format!("could not look up project rows: {e}"))?;
            if tracked > 0 {
                summary.purged += 1;
            }
            del_transcript
                .execute(params![path])
                .map_err(|e| format!("could not delete a transcript: {e}"))?;
            del_trash
                .execute(params![path])
                .map_err(|e| format!("could not delete a trash row: {e}"))?;
            del_project
                .execute(params![path])
                .map_err(|e| format!("could not delete a project row: {e}"))?;
            del_media
                .execute(params![path])
                .map_err(|e| format!("could not delete a media cache row: {e}"))?;
        }
    }

    tx.commit()
        .map_err(|e| format!("could not commit purge: {e}"))?;
    Ok(summary)
}

/// Drop every binned project for good. Same file-cleanup contract as
/// [`purge_projects`], which does the actual work.
pub fn purge_all_trash(conn: &Connection) -> Result<PurgeSummary, String> {
    let paths = load_trash(conn)?
        .into_iter()
        .map(|item| item.source_path)
        .collect::<Vec<_>>();
    purge_projects(conn, &paths)
}

/// Drop every binned project whose retention window has passed.
///
/// The retention is user-settable and defaults to 12 days; `days <= 0` means
/// "never auto-delete" and removes nothing. Like every purge here, this only
/// touches the app's rows — the user's video file is never removed.
pub fn purge_expired_trash(conn: &Connection, days: i64) -> Result<PurgeSummary, String> {
    if days <= 0 {
        return Ok(PurgeSummary::default());
    }
    let cutoff = now_unix() - days * 86_400;
    let paths_res = load_trash(conn);
    let paths = paths_res?
        .into_iter()
        .filter(|item| item.deleted_at < cutoff)
        .map(|item| item.source_path)
        .collect::<Vec<_>>();
    purge_projects(conn, &paths)
}

/// Delete transcript lines and probe-cache rows whose source path is **neither
/// in the list nor in the bin** — rows no view can ever reach again.
///
/// The live database carried 43 such transcript rows (5 dead sources) and 8
/// probe-cache rows; this sweep is what keeps that from growing. Runs once at
/// startup, after the trash retention purge.
pub fn sweep_orphans(conn: &Connection) -> Result<PurgeSummary, String> {
    let mut summary = PurgeSummary::default();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("could not start transaction: {e}"))?;

    const ORPHAN_SQL: &str =
        "NOT IN (SELECT source_path FROM projects UNION SELECT source_path FROM trash)";

    // Keys first — the rows are about to be deleted by the same transaction.
    if media_cache_exists(&tx) {
        let mut stmt = tx
            .prepare(&format!(
                "SELECT source_path, cache_key FROM media_cache
                  WHERE cache_key != '' AND source_path {ORPHAN_SQL}"
            ))
            .map_err(|e| format!("could not prepare orphan key scan: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PurgedEntry {
                    path: r.get(0)?,
                    cache_key: r.get(1)?,
                })
            })
            .map_err(|e| format!("could not scan orphan cache keys: {e}"))?;
        for row in rows {
            summary
                .entries
                .push(row.map_err(|e| format!("could not read an orphan cache key: {e}"))?);
        }
    }

    summary.orphan_rows += tx
        .execute(
            &format!("DELETE FROM transcripts WHERE source_path {ORPHAN_SQL}"),
            [],
        )
        .map_err(|e| format!("could not delete orphan transcripts: {e}"))?;
    if media_cache_exists(&tx) {
        summary.orphan_rows += tx
            .execute(
                &format!("DELETE FROM media_cache WHERE source_path {ORPHAN_SQL}"),
                [],
            )
            .map_err(|e| format!("could not delete orphan media cache rows: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("could not commit orphan sweep: {e}"))?;
    Ok(summary)
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
        let roundabout = canonical_path(
            &dir.join("..")
                .join(dir.file_name().unwrap())
                .join("clip.mp4")
                .to_string_lossy(),
        );

        assert_eq!(direct, roundabout);
        assert!(!direct.contains(".."));
    }

    #[test]
    fn canonical_path_is_stable_for_a_missing_file() {
        // A file that does not exist yet still gets a stable, absolute key.
        let missing = std::env::temp_dir()
            .join("t9editorlit-not-here")
            .join("x.mp4");
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

        assert_eq!(
            resume_project(&conn).unwrap(),
            Some(canonical_path(&alive.to_string_lossy()))
        );
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
    fn save_transcript_rewrites_only_changed_rows() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let first = vec![line("1", "a"), line("2", "b"), line("3", "c")];
        assert_eq!(save_transcript(&conn, &canon("/v.mp4"), &first).unwrap(), 3);

        // A no-op autosave tick must write zero rows.
        let same = vec![line("1", "a"), line("2", "b"), line("3", "c")];
        assert_eq!(
            save_transcript(&conn, &canon("/v.mp4"), &same).unwrap(),
            0
        );

        // One text edit → exactly one rewritten row.
        let edited = vec![line("1", "a"), line("2", "b fixed"), line("3", "c")];
        assert_eq!(
            save_transcript(&conn, &canon("/v.mp4"), &edited).unwrap(),
            1
        );

        // One split/merge removal → the stale delete alone.
        let shrunk = vec![line("1", "a"), line("3", "c")];
        assert_eq!(
            save_transcript(&conn, &canon("/v.mp4"), &shrunk).unwrap(),
            1
        );

        let loaded = load_transcript(&conn, &canon("/v.mp4")).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].text, "a");
        assert_eq!(loaded[1].text, "c");
    }

    #[test]
    fn absent_words_never_erase_the_stored_timings() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();

        let mut worded = line("1", "hello");
        worded.words = Some(vec![Word {
            word: "he".into(),
            start: 0.0,
            end: 0.5,
        }]);
        assert_eq!(
            save_transcript(&conn, &canon("/v.mp4"), &[worded.clone()]).unwrap(),
            1
        );

        // The same line without the word list: the stored JSON must survive.
        let bare = line("1", "hello");
        assert_eq!(save_transcript(&conn, &canon("/v.mp4"), &[bare]).unwrap(), 0);

        let loaded = load_transcript(&conn, &canon("/v.mp4")).unwrap();
        assert_eq!(loaded[0].words.as_ref().unwrap().len(), 1);
        assert_eq!(loaded[0].words.as_ref().unwrap()[0].word, "he");
    }

    /* ------------------------------------------------------ diff-save + purge */

    /// The probe cache, as the media module shapes it, on an in-memory db.
    fn media_cache_table(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE media_cache (
                 source_path TEXT PRIMARY KEY,
                 size_bytes  INTEGER NOT NULL,
                 mtime_secs  INTEGER NOT NULL,
                 json        TEXT NOT NULL,
                 cache_key   TEXT NOT NULL DEFAULT ''
             );",
        )
        .unwrap();
    }

    /// canonical_path resolves a Windows root for a bare "/name", so every
    /// comparison in these tests goes through it.
    fn canon(p: &str) -> String {
        canonical_path(p)
    }

    #[test]
    fn purge_projects_scours_every_table_and_hands_back_the_keys() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        media_cache_table(&conn);

        let key_path = canon("/v.mp4");
        conn.execute(
            "INSERT INTO media_cache (source_path, size_bytes, mtime_secs, json, cache_key)
             VALUES (?1, 1, 1, '{}', 'abc123')",
            params![key_path],
        )
        .unwrap();

        save_project(&conn, "p1", "Video", "/v.mp4", 60.0, 100).unwrap();
        save_transcript(&conn, "/v.mp4", &[line("1", "hi")]).unwrap();

        let summary = purge_projects(&conn, &[key_path.clone()]).unwrap();
        assert_eq!(summary.purged, 1);
        assert_eq!(summary.entries.len(), 1);
        assert_eq!(summary.entries[0].path, key_path);
        assert_eq!(summary.entries[0].cache_key, "abc123");

        assert!(load_projects(&conn).unwrap().is_empty());
        assert!(load_trash(&conn).unwrap().is_empty());
        assert!(load_transcript(&conn, "/v.mp4").unwrap().is_empty());
        let cache_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM media_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cache_rows, 0);
    }

    #[test]
    fn sweep_orphans_removes_rows_no_view_can_reach() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        media_cache_table(&conn);

        // Alive: one project on the list, one in the bin (trash keeps its
        // transcript on purpose — a restore must not re-transcribe).
        save_project(&conn, "p1", "Video", "/v.mp4", 60.0, 100).unwrap();
        save_transcript(&conn, "/v.mp4", &[line("1", "hi")]).unwrap();
        save_project(&conn, "p2", "Binned", "/bin.mp4", 60.0, 100).unwrap();
        trash_project(&conn, "/bin.mp4").unwrap();
        save_transcript(&conn, "/bin.mp4", &[line("1", "ho")]).unwrap();

        // Orphans: a transcript and a probe row for a path in neither table,
        // plus a second orphan transcript for good measure.
        save_transcript(&conn, "/gone.mp4", &[line("1", "bye")]).unwrap();
        save_transcript(&conn, "/gone2.mp4", &[line("1", "gone too")]).unwrap();
        conn.execute(
            "INSERT INTO media_cache (source_path, size_bytes, mtime_secs, json, cache_key)
             VALUES (?1, 1, 1, '{}', 'dead beef')",
            params![canon("/gone.mp4")],
        )
        .unwrap();

        let summary = sweep_orphans(&conn).unwrap();
        // 2 transcript rows + 1 media-cache row.
        assert_eq!(summary.orphan_rows, 3);
        assert_eq!(summary.entries.len(), 1);
        assert_eq!(summary.entries[0].path, canon("/gone.mp4"));
        assert_eq!(summary.entries[0].cache_key, "dead beef");

        assert_eq!(load_transcript(&conn, "/v.mp4").unwrap().len(), 1);
        assert!(load_transcript(&conn, "/bin.mp4").unwrap().len() == 1);
        assert!(load_transcript(&conn, "/gone.mp4").unwrap().is_empty());
        assert!(load_transcript(&conn, "/gone2.mp4").unwrap().is_empty());
    }

    #[test]
    fn purge_expired_trash_only_takes_what_is_old_enough() {
        let conn = mem_conn();
        init_schema(&conn).unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;

        save_project(&conn, "p1", "Old", "/old.mp4", 60.0, now).unwrap();
        save_project(&conn, "p2", "Fresh", "/new.mp4", 60.0, now).unwrap();
        trash_project(&conn, "/old.mp4").unwrap();
        trash_project(&conn, "/new.mp4").unwrap();
        // Backdate one row so only it passes the 12-day window.
        conn.execute(
            "UPDATE trash SET deleted_at = ?1 WHERE source_path = ?2",
            params![now - 13 * 86_400, canon("/old.mp4")],
        )
        .unwrap();

        let summary = purge_expired_trash(&conn, 12).unwrap();
        assert_eq!(summary.purged, 1);
        let remaining = load_trash(&conn).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].name, "Fresh");
    }
}
