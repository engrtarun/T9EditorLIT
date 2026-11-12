//! Disk-first telemetry: sessions, RAM samples, edit history, child-process
//! timings, jobs, exports, errors and a tiny key-value drawer.
//!
//! Design rules (the zero-RAM directive applies here too):
//!
//! * **Nothing is buffered in RAM for long.** Rows travel over a channel to one
//!   background writer that commits each small burst in a single transaction
//!   and forgets it. The queue between flushes holds at most a handful of
//!   rows (the 15-second metric samples).
//! * **The hot paths never touch SQLite.** `log_*` calls are a channel send —
//!   they cannot block a UI edit or an FFmpeg run.
//! * **WAL + `synchronous=NORMAL`** so the writer coexists with the per-command
//!   connections the rest of the engine opens, without lock juggling.
//! * **Pruned on start-up**: raw rows age out (metrics 7 days, events 30 days,
//!   …) so the file stays small forever.
//! * Every call **degrades to a no-op** when `start()` never ran (tests, the
//!   sibling crate, a failed open): telemetry must never break the app.

// The API is a deliberate superset: not every entry point fires from every
// crate (the sibling app records no exports of its own).
#![allow(dead_code)]

use rusqlite::{Connection, params};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/* ================================================================ plumbing */

enum Msg {
    Event {
        ts: i64,
        level: String,
        component: String,
        message: String,
    },
    Edit {
        ts: i64,
        project: String,
        action: String,
        payload: String,
    },
    Metric {
        ts: i64,
        app_mb: i64,
        sys_used_mb: i64,
        sys_used_pct: f64,
        phase: String,
    },
    Child {
        ts: i64,
        job: String,
        duration_ms: i64,
        exit_code: i32,
    },
    Job {
        source: String,
        status: String,
        provider: String,
        audio_secs: f64,
        error: String,
        started_at: i64,
        finished_at: i64,
    },
    Export {
        project: String,
        preset: String,
        out_path: String,
        size_bytes: i64,
        status: String,
        started_at: i64,
        finished_at: i64,
    },
    Transfer {
        id: String,
        direction: String,
        total_bytes: i64,
        done_bytes: i64,
        status: String,
    },
    Revision {
        ts: i64,
        project: String,
        label: String,
        payload: String,
    },
    Kv {
        key: String,
        value: String,
    },
    SessionEnd {
        id: i64,
    },
    Shutdown,
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();
// The writer handle lives in a plain Mutex so `shutdown_blocking` can `take()`
// it out and `join()` it — `join` needs ownership.
static WRITER: Mutex<Option<thread::JoinHandle<()>>> = Mutex::new(None);
/// The row id of the session this process started; `0` until `start()` runs.
static SESSION: Mutex<i64> = Mutex::new(0);

/// One close path calls this; `ExitRequested` calls it again. The flush must
/// happen exactly once - a second send would hit a dead writer and, worse,
/// could interleave with the first join.
static SHUTDOWN_DONE: AtomicBool = AtomicBool::new(false);
/// What the app is doing, for the metric sampler: `idle` · `exporting` …
static PHASE: Mutex<String> = Mutex::new(String::new());

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn send(msg: Msg) {
    if let Some(tx) = TX.get() {
        let _ = tx.send(msg);
    }
}

/* ================================================================== schema */

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS app_metrics (
    id           INTEGER PRIMARY KEY,
    ts           INTEGER NOT NULL,
    app_mb       INTEGER NOT NULL,
    sys_used_mb  INTEGER NOT NULL,
    sys_used_pct REAL    NOT NULL,
    phase        TEXT    NOT NULL DEFAULT 'idle'
);
CREATE TABLE IF NOT EXISTS child_metrics (
    id          INTEGER PRIMARY KEY,
    ts          INTEGER NOT NULL,
    job         TEXT    NOT NULL,
    duration_ms INTEGER NOT NULL,
    exit_code   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS edit_actions (
    id      INTEGER PRIMARY KEY,
    ts      INTEGER NOT NULL,
    project TEXT    NOT NULL,
    action  TEXT    NOT NULL,
    payload TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS project_revisions (
    id      INTEGER PRIMARY KEY,
    ts      INTEGER NOT NULL,
    project TEXT    NOT NULL,
    label   TEXT    NOT NULL,
    payload TEXT    NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    app_version TEXT    NOT NULL DEFAULT '',
    clean_exit  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS transcription_jobs (
    id           INTEGER PRIMARY KEY,
    source_path  TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    provider     TEXT    NOT NULL DEFAULT '',
    audio_secs   REAL    NOT NULL DEFAULT 0,
    error        TEXT    NOT NULL DEFAULT '',
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER
);
CREATE TABLE IF NOT EXISTS exports (
    id          INTEGER PRIMARY KEY,
    project     TEXT    NOT NULL,
    preset      TEXT    NOT NULL DEFAULT '',
    out_path    TEXT    NOT NULL DEFAULT '',
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS app_events (
    id        INTEGER PRIMARY KEY,
    ts        INTEGER NOT NULL,
    level     TEXT    NOT NULL,
    component TEXT    NOT NULL,
    message   TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS vault_transfers (
    id          TEXT PRIMARY KEY,
    direction   TEXT    NOT NULL,
    total_bytes INTEGER NOT NULL DEFAULT 0,
    done_bytes  INTEGER NOT NULL DEFAULT 0,
    status      TEXT    NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_calls (
    id           INTEGER PRIMARY KEY,
    ts           INTEGER NOT NULL,
    service      TEXT    NOT NULL,
    op           TEXT    NOT NULL DEFAULT '',
    model        TEXT    NOT NULL DEFAULT '',
    key_id       TEXT    NOT NULL DEFAULT '',
    status       INTEGER NOT NULL DEFAULT 0,
    latency_ms   INTEGER NOT NULL DEFAULT 0,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    audio_secs   REAL    NOT NULL DEFAULT 0,
    err          TEXT    NOT NULL DEFAULT '',
    req_limit    INTEGER NOT NULL DEFAULT 0,
    req_remaining INTEGER NOT NULL DEFAULT 0,
    req_reset    TEXT    NOT NULL DEFAULT '',
    tok_limit    INTEGER NOT NULL DEFAULT 0,
    tok_remaining INTEGER NOT NULL DEFAULT 0,
    tok_reset    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_api_calls_ts ON api_calls(ts);
CREATE INDEX IF NOT EXISTS idx_api_calls_service ON api_calls(service);
CREATE TABLE IF NOT EXISTS api_usage_daily (
    day          TEXT    NOT NULL,
    service      TEXT    NOT NULL,
    calls        INTEGER NOT NULL DEFAULT 0,
    tokens_in    INTEGER NOT NULL DEFAULT 0,
    tokens_out   INTEGER NOT NULL DEFAULT 0,
    audio_secs   REAL    NOT NULL DEFAULT 0,
    errors       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, service)
);
CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts   ON app_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_events_ts    ON app_events(ts);
CREATE INDEX IF NOT EXISTS idx_child_ts     ON child_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_edits_ts     ON edit_actions(ts);
CREATE INDEX IF NOT EXISTS idx_edits_proj   ON edit_actions(project);
";

const PRAGMAS: &str = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;";

/// The ten telemetry tables.
///
/// They now live in their own `telemetry.db`; copies still inside the main
/// app database are legacy and get dropped by [`drop_legacy_tables`].
const ALL_TABLES: &[&str] = &[
    "app_metrics",
    "child_metrics",
    "edit_actions",
    "project_revisions",
    "sessions",
    "transcription_jobs",
    "exports",
    "app_events",
    "vault_transfers",
    "api_calls",
    "api_usage_daily",
    "kv",
];

/// Remove the telemetry tables that used to live in the **main** app database.
///
/// Telemetry moved to its own file so the transcript/trash/probe engine
/// (`nanamicut.db`) never pays for WAL growth it does not use. Runs once at
/// startup on the main database, best-effort: a missing table, a lock held by
/// an old build still running, or a read-only dir is simply left for the next
/// launch. The app tables (`transcripts`, `projects`, `trash`,
/// `media_cache`, `keyframes`) are never touched.
pub fn drop_legacy_tables(app_db_path: &Path) {
    let Ok(conn) = Connection::open(app_db_path) else {
        return;
    };
    // An old build can hold this file; never let hygiene stall the launch.
    let _ = conn.execute_batch("PRAGMA busy_timeout = 3000;");
    for table in ALL_TABLES {
        let _ = conn.execute(&format!("DROP TABLE IF EXISTS {table}"), []);
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
    let _ = conn.close();
}

/// How long raw rows survive, in seconds. Run once per launch — by then the
/// tables are small (a day of metrics is ~5 700 rows of ~40 bytes).
const KEEP_METRICS_SECS: i64 = 7 * 24 * 3600;
const KEEP_EVENTS_SECS: i64 = 30 * 24 * 3600;
const KEEP_CHILD_SECS: i64 = 14 * 24 * 3600;
const KEEP_EDITS_SECS: i64 = 180 * 24 * 3600;
const KEEP_JOBS_SECS: i64 = 90 * 24 * 3600;

fn prune(conn: &Connection) -> Result<(), String> {
    let cutoff = |keep: i64| now() - keep;
    conn.execute(
        "DELETE FROM app_metrics WHERE ts < ?1",
        params![cutoff(KEEP_METRICS_SECS)],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM app_events WHERE ts < ?1",
        params![cutoff(KEEP_EVENTS_SECS)],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM child_metrics WHERE ts < ?1",
        params![cutoff(KEEP_CHILD_SECS)],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM edit_actions WHERE ts < ?1",
        params![cutoff(KEEP_EDITS_SECS)],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM transcription_jobs WHERE started_at < ?1 AND finished_at IS NOT NULL",
        params![cutoff(KEEP_JOBS_SECS)],
    )
    .map_err(|e| e.to_string())?;
    // Crash evidence is kept: sessions with a NULL ended_at stay forever, and
    // a closed run older than a quarter adds nothing.
    conn.execute(
        "DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ?1",
        params![cutoff(KEEP_JOBS_SECS)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/* =============================================================== lifecycle */

/// Open (and migrate) the stats tables, record the session, then start the
/// background writer and the metric sampler.
///
/// Safe to call twice — the second call does nothing.
pub fn start(db_path: &Path, app_version: &str) {
    if TX.get().is_some() {
        return;
    }
    if let Some(parent) = db_path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }

    // The one synchronous touch: schema + prune + the session row. On a
    // pruned database this is a few milliseconds, once per launch.
    let session_id = {
        let conn = match Connection::open(db_path) {
            Ok(c) => c,
            Err(_) => return,
        };
        if conn.execute_batch(PRAGMAS).is_err() {
            return;
        }
        if conn.execute_batch(SCHEMA).is_err() {
            return;
        }
        let _ = prune(&conn);
        let started = now();
        if conn
            .execute(
                "INSERT INTO sessions (started_at, app_version) VALUES (?1, ?2)",
                params![started, app_version],
            )
            .is_err()
        {
            return;
        }
        conn.last_insert_rowid()
    };
    if let Ok(mut guard) = SESSION.lock() {
        *guard = session_id;
    }

    let (tx, rx) = channel::<Msg>();
    if TX.set(tx).is_err() {
        return;
    }
    let writer_path: PathBuf = db_path.to_path_buf();
    let handle = thread::spawn(move || writer_loop(writer_path, rx));
    if let Ok(mut guard) = WRITER.lock() {
        *guard = Some(handle);
    }

    // The sampler rides the same channel: no second connection, no lock.
    thread::spawn(sampler_loop);
}

/// Flush everything and stop the writer. Called from Tauri's `ExitRequested`
/// so the session row gets its `ended_at` and no edit is lost at close.
pub fn shutdown_blocking() {
    if SHUTDOWN_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(tx) = TX.get() else { return };
    let id = SESSION.lock().map(|g| *g).unwrap_or(0);
    if id != 0 {
        let _ = tx.send(Msg::SessionEnd { id });
    }
    let _ = tx.send(Msg::Shutdown);
    let handle = WRITER.lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

/* ================================================================= writer */

fn writer_loop(path: PathBuf, rx: Receiver<Msg>) {
    let conn = match Connection::open(&path) {
        Ok(c) => c,
        Err(_) => return,
    };
    if conn.execute_batch(PRAGMAS).is_err() {
        return;
    }
    let mut conn = conn;
    let mut batch: Vec<Msg> = Vec::new();

    loop {
        let first = match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(m) => m,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        if matches!(first, Msg::Shutdown) {
            break;
        }
        batch.push(first);
        // A burst (export finish, edit log, sampler tick) lands in ONE
        // transaction instead of one fsync each.
        while let Ok(m) = rx.try_recv() {
            if matches!(m, Msg::Shutdown) {
                flush(&mut conn, &batch);
                return;
            }
            batch.push(m);
        }
        flush(&mut conn, &batch);
        batch.clear();
    }
    flush(&mut conn, &batch);
}

fn flush(conn: &mut Connection, batch: &[Msg]) {
    if batch.is_empty() {
        return;
    }
    let Ok(tx) = conn.transaction() else { return };
    for msg in batch {
        let _ = insert(&tx, msg);
    }
    let _ = tx.commit();
}

fn insert(conn: &Connection, msg: &Msg) -> Result<(), rusqlite::Error> {
    match msg {
        Msg::Event {
            ts,
            level,
            component,
            message,
        } => {
            conn.execute(
                "INSERT INTO app_events (ts, level, component, message) VALUES (?1, ?2, ?3, ?4)",
                params![ts, level, component, message],
            )?;
        }
        Msg::Edit {
            ts,
            project,
            action,
            payload,
        } => {
            conn.execute(
                "INSERT INTO edit_actions (ts, project, action, payload) VALUES (?1, ?2, ?3, ?4)",
                params![ts, project, action, payload],
            )?;
        }
        Msg::Metric {
            ts,
            app_mb,
            sys_used_mb,
            sys_used_pct,
            phase,
        } => {
            conn.execute(
                "INSERT INTO app_metrics (ts, app_mb, sys_used_mb, sys_used_pct, phase)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![ts, app_mb, sys_used_mb, sys_used_pct, phase],
            )?;
        }
        Msg::Child {
            ts,
            job,
            duration_ms,
            exit_code,
        } => {
            conn.execute(
                "INSERT INTO child_metrics (ts, job, duration_ms, exit_code) VALUES (?1, ?2, ?3, ?4)",
                params![ts, job, duration_ms, exit_code],
            )?;
        }
        Msg::Job {
            source,
            status,
            provider,
            audio_secs,
            error,
            started_at,
            finished_at,
        } => {
            conn.execute(
                "INSERT INTO transcription_jobs
                     (source_path, status, provider, audio_secs, error, started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    source,
                    status,
                    provider,
                    audio_secs,
                    error,
                    started_at,
                    finished_at
                ],
            )?;
        }
        Msg::Export {
            project,
            preset,
            out_path,
            size_bytes,
            status,
            started_at,
            finished_at,
        } => {
            conn.execute(
                "INSERT INTO exports
                     (project, preset, out_path, size_bytes, status, started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    project,
                    preset,
                    out_path,
                    size_bytes,
                    status,
                    started_at,
                    finished_at
                ],
            )?;
        }
        Msg::Transfer {
            id,
            direction,
            total_bytes,
            done_bytes,
            status,
        } => {
            conn.execute(
                "INSERT INTO vault_transfers (id, direction, total_bytes, done_bytes, status, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                     done_bytes = excluded.done_bytes,
                     status     = excluded.status",
                params![id, direction, total_bytes, done_bytes, status, now()],
            )?;
        }
        Msg::Revision {
            ts,
            project,
            label,
            payload,
        } => {
            conn.execute(
                "INSERT INTO project_revisions (ts, project, label, payload) VALUES (?1, ?2, ?3, ?4)",
                params![ts, project, label, payload],
            )?;
        }
        Msg::Kv { key, value } => {
            conn.execute(
                "INSERT INTO kv (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
        }
        Msg::SessionEnd { id } => {
            conn.execute(
                "UPDATE sessions SET ended_at = ?1, clean_exit = 1 WHERE id = ?2 AND ended_at IS NULL",
                params![now(), id],
            )?;
        }
        // Handled before insertion; nothing to write.
        Msg::Shutdown => {}
    }
    Ok(())
}

/* ================================================================ sampler */

fn sampler_loop() {
    let mut probe = crate::memory::MemoryProbe::new();
    loop {
        // One quiet sleep between samples: no timer wheel, no wakeups beyond
        // one thread every 15 seconds.
        std::thread::sleep(Duration::from_secs(15));
        let stats = probe.sample();
        let phase = PHASE.lock().map(|p| p.clone()).unwrap_or_default();
        let phase = if phase.is_empty() {
            "idle".to_string()
        } else {
            phase
        };
        send(Msg::Metric {
            ts: now(),
            app_mb: stats.app_mb as i64,
            sys_used_mb: stats.used_mb as i64,
            sys_used_pct: stats.used_percent as f64,
            phase,
        });
    }
}

/* ================================================================== API */

/// One line in the diagnostic log. `level` is `info` · `warn` · `error`.
pub fn log_event(level: &str, component: &str, message: &str) {
    send(Msg::Event {
        ts: now(),
        level: level.to_string(),
        component: component.to_string(),
        message: message.chars().take(2000).collect(),
    });
}

/// One real edit burst (autosave, rename, …) — the "user progress" trail.
/// `payload` is a small JSON string (counts, ids).
pub fn log_edit(project: &str, action: &str, payload: &str) {
    send(Msg::Edit {
        ts: now(),
        project: project.chars().take(300).collect(),
        action: action.to_string(),
        payload: payload.chars().take(4000).collect(),
    });
}

/// A finished FFmpeg/FFprobe child: proof the zero-RAM rule (spawn → exit).
pub fn log_child(job: &str, duration_ms: i64, exit_code: i32) {
    send(Msg::Child {
        ts: now(),
        job: job.to_string(),
        duration_ms,
        exit_code,
    });
}

/// One transcription run, written when it finishes.
/// `started_at` is `finished_at - elapsed_secs` so the row keeps the span.
#[allow(clippy::too_many_arguments)]
pub fn log_job(
    source: &str,
    status: &str,
    provider: &str,
    audio_secs: f64,
    error: &str,
    elapsed_secs: f64,
) {
    let finished = now();
    let started = finished - elapsed_secs.max(0.0) as i64;
    send(Msg::Job {
        source: source.to_string(),
        status: status.to_string(),
        provider: provider.to_string(),
        audio_secs,
        error: error.chars().take(2000).collect(),
        started_at: started,
        finished_at: finished,
    });
}

/// One export, written when it finishes.
#[allow(clippy::too_many_arguments)]
pub fn log_export(
    project: &str,
    preset: &str,
    out_path: &str,
    size_bytes: i64,
    status: &str,
    started_at: i64,
) {
    send(Msg::Export {
        project: project.chars().take(300).collect(),
        preset: preset.to_string(),
        out_path: out_path.chars().take(600).collect(),
        size_bytes,
        status: status.to_string(),
        started_at,
        finished_at: now(),
    });
}

/// A Telegram vault transfer (or its progress update — same id updates the row).
pub fn log_transfer(id: &str, direction: &str, total_bytes: i64, done_bytes: i64, status: &str) {
    send(Msg::Transfer {
        id: id.to_string(),
        direction: direction.to_string(),
        total_bytes,
        done_bytes,
        status: status.to_string(),
    });
}

/// A labelled snapshot point for a project (future "restore to here").
pub fn log_revision(project: &str, label: &str, payload: &str) {
    send(Msg::Revision {
        ts: now(),
        project: project.chars().take(300).collect(),
        label: label.to_string(),
        payload: payload.chars().take(200_000).collect(),
    });
}

/// Store a small key/value pair (onboarding flags, last settings…).
pub fn kv_set(key: &str, value: &str) {
    send(Msg::Kv {
        key: key.to_string(),
        value: value.chars().take(16_000).collect(),
    });
}

/// Read a key back. Rare enough that opening a short-lived WAL connection
/// (sub-millisecond) beats juggling a response channel.
pub fn kv_get(db_path: &Path, key: &str) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    let mut stmt = conn.prepare("SELECT value FROM kv WHERE key = ?1").ok()?;
    stmt.query_row(params![key], |row| row.get(0)).ok()
}

/// What the app is doing right now — stamped onto the next metric sample.
pub fn set_phase(phase: &str) {
    if let Ok(mut guard) = PHASE.lock() {
        *guard = phase.to_string();
    }
}

/// Current phase, `idle` when unset.
pub fn phase() -> String {
    let p = PHASE.lock().map(|g| g.clone()).unwrap_or_default();
    if p.is_empty() { "idle".to_string() } else { p }
}

/// This process's session row id (0 before `start`).
pub fn session_id() -> i64 {
    SESSION.lock().map(|g| *g).unwrap_or(0)
}

/// Ingest new rows from the daemon's append-only call log into telemetry.db.
///
/// The file is JSONL (one object per line). Only lines after the last
/// successfully consumed byte offset are read, so calling this repeatedly is
/// cheap and idempotent. The offset is persisted in the `kv` table under
/// `api_calls_offset`, so a restart never re-imports the same lines.
///
/// Returns the number of rows inserted.
pub fn ingest_api_calls(db_path: &Path, calls_path: &str) -> Result<i64, String> {
    if calls_path.is_empty() {
        return Ok(0);
    }
    let offset: i64 = kv_get(db_path, "api_calls_offset")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let file = match std::fs::File::open(calls_path) {
        Ok(f) => f,
        Err(_) => return Ok(0), // daemon hasn't written yet, or older daemon
    };
    use std::io::{BufRead, Seek, SeekFrom};
    let mut reader = std::io::BufReader::new(file);
    if reader.seek(SeekFrom::Start(offset as u64)).is_err() {
        return Err("seek failed".to_string());
    }

    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut inserted: i64 = 0;
    let mut consumed: u64 = offset as u64;
    let mut line_buf = String::new();
    loop {
        line_buf.clear();
        let n = match reader.read_line(&mut line_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        // A partial final line (no trailing newline) is NOT consumed: leave the
        // offset where it is so the next call picks it up once it's complete.
        if !line_buf.ends_with('\n') {
            // rewind the consumed count for this partial line
            consumed -= n as u64;
            break;
        }
        consumed += n as u64;
        let trimmed = line_buf.trim();
        if trimmed.is_empty() {
            continue;
        }
        let row: CallLogRow = match serde_json::from_str(trimmed) {
            Ok(r) => r,
            Err(_) => continue, // skip malformed lines, never block the rest
        };
        let ts = parse_rfc3339(&row.at);
        if tx
            .execute(
                "INSERT INTO api_calls
                    (ts, service, op, model, key_id, status, latency_ms, tokens_in,
                     tokens_out, audio_secs, err, req_limit, req_remaining, req_reset,
                     tok_limit, tok_remaining, tok_reset)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
                params![
                    ts,
                    row.service,
                    row.op,
                    row.model,
                    row.key_id,
                    row.status,
                    row.latency_ms,
                    row.tokens_in,
                    row.tokens_out,
                    row.audio_secs,
                    row.err,
                    row.req_limit,
                    row.req_remaining,
                    row.req_reset,
                    row.tok_limit,
                    row.tok_remaining,
                    row.tok_reset,
                ],
            )
            .is_ok()
        {
            inserted += 1;
            // roll up the daily bucket
            let day = if row.at.len() >= 10 { &row.at[..10] } else { "" };
            let _ = tx.execute(
                "INSERT INTO api_usage_daily (day, service, calls, tokens_in, tokens_out, audio_secs, errors)
                 VALUES (?1,?2,1,?3,?4,?5,?6)
                 ON CONFLICT(day, service) DO UPDATE SET
                    calls = calls + 1,
                    tokens_in = tokens_in + excluded.tokens_in,
                    tokens_out = tokens_out + excluded.tokens_out,
                    audio_secs = audio_secs + excluded.audio_secs,
                    errors = errors + excluded.errors",
                params![
                    day,
                    row.service,
                    row.tokens_in,
                    row.tokens_out,
                    row.audio_secs,
                    if row.status >= 400 || !row.err.is_empty() { 1i64 } else { 0i64 },
                ],
            );
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    // persist the new offset
    let conn2 = Connection::open(db_path).map_err(|e| e.to_string())?;
    let _ = conn2.execute(
        "INSERT INTO kv (key, value) VALUES ('api_calls_offset', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![consumed.to_string()],
    );
    Ok(inserted)
}

#[derive(serde::Deserialize, Default)]
struct CallLogRow {
    service: String,
    #[serde(default)]
    op: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    key_id: String,
    #[serde(default)]
    at: String,
    #[serde(default)]
    status: i64,
    #[serde(default)]
    latency_ms: i64,
    #[serde(default)]
    tokens_in: i64,
    #[serde(default)]
    tokens_out: i64,
    #[serde(default)]
    audio_secs: f64,
    #[serde(default)]
    err: String,
    #[serde(default)]
    req_limit: i64,
    #[serde(default)]
    req_remaining: i64,
    #[serde(default)]
    req_reset: String,
    #[serde(default)]
    tok_limit: i64,
    #[serde(default)]
    tok_remaining: i64,
    #[serde(default)]
    tok_reset: String,
}

fn parse_rfc3339(s: &str) -> i64 {
    if s.len() < 19 {
        return 0;
    }
    let b = s.as_bytes();
    let parse2 = |i: usize| -> i64 {
        ((b[i] as i64) - 48) * 10 + ((b[i + 1] as i64) - 48)
    };
    let y: i64 = (b[0] as i64 - 48) * 1000
        + (b[1] as i64 - 48) * 100
        + (b[2] as i64 - 48) * 10
        + (b[3] as i64 - 48);
    let m = parse2(5);
    let d = parse2(8);
    let hh = parse2(11);
    let mm = parse2(14);
    let ss = parse2(17);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return 0;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + hh * 3600 + mm * 60 + ss
}

/// One ingested call, for the UI's recent-call table.
#[derive(serde::Serialize)]
pub struct ApiCallRow {
    pub id: i64,
    pub ts: i64,
    pub service: String,
    pub op: String,
    pub model: String,
    pub key_id: String,
    pub status: i64,
    pub latency_ms: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub audio_secs: f64,
    pub err: String,
}

/// One day bucket, for the 30-day timeline.
#[derive(serde::Serialize)]
pub struct UsageDayRow {
    pub day: String,
    pub service: String,
    pub calls: i64,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub audio_secs: f64,
    pub errors: i64,
}

fn map_api_call_row(r: &rusqlite::Row) -> rusqlite::Result<ApiCallRow> {
    Ok(ApiCallRow {
        id: r.get(0)?,
        ts: r.get(1)?,
        service: r.get(2)?,
        op: r.get(3)?,
        model: r.get(4)?,
        key_id: r.get(5)?,
        status: r.get(6)?,
        latency_ms: r.get(7)?,
        tokens_in: r.get(8)?,
        tokens_out: r.get(9)?,
        audio_secs: r.get(10)?,
        err: r.get(11)?,
    })
}

pub fn query_api_calls(db_path: &Path, service: &str, limit: i64) -> Result<Vec<ApiCallRow>, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let sql = if service.is_empty() {
        "SELECT id, ts, service, op, model, key_id, status, latency_ms, tokens_in, tokens_out, audio_secs, err
         FROM api_calls ORDER BY id DESC LIMIT ?1"
    } else {
        "SELECT id, ts, service, op, model, key_id, status, latency_ms, tokens_in, tokens_out, audio_secs, err
         FROM api_calls WHERE service = ?2 ORDER BY id DESC LIMIT ?1"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let lim = if limit <= 0 { 100 } else { limit };
    let mut out = Vec::new();
    let mapped = if service.is_empty() {
        stmt.query_map(params![lim], map_api_call_row)
    } else {
        stmt.query_map(params![lim, service], map_api_call_row)
    };
    if let Ok(rows) = mapped {
        for r in rows.flatten() {
            out.push(r);
        }
    }
    Ok(out)
}

pub fn query_usage_daily(db_path: &Path, days: i64) -> Result<Vec<UsageDayRow>, String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT day, service, calls, tokens_in, tokens_out, audio_secs, errors
                  FROM api_usage_daily ORDER BY day DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;
    // days * 3 services approx; cap generously
    let cap = if days <= 0 { 90 } else { days * 4 };
    let rows = stmt
        .query_map(params![cap], |r| Ok(UsageDayRow {
            day: r.get(0)?, service: r.get(1)?, calls: r.get(2)?,
            tokens_in: r.get(3)?, tokens_out: r.get(4)?, audio_secs: r.get(5)?,
            errors: r.get(6)?,
        }))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        out.push(r);
    }
    Ok(out)
}

/// Milliseconds since an arbitrary instant — child-process timing helper.
pub fn millis_since(start: Instant) -> i64 {
    start.elapsed().as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // The WAL pragmas only matter for on-disk databases; the schema itself
        // is what must work anywhere.
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    #[test]
    fn schema_creates_every_table_empty() {
        let conn = mem_db();
        for table in ALL_TABLES {
            let count: i64 = conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap_or_else(|e| panic!("{table} missing from the schema: {e}"));
            assert_eq!(count, 0, "{table} should start empty");
        }
    }

    #[test]
    fn edit_rows_round_trip() {
        let conn = mem_db();
        insert(
            &conn,
            &Msg::Edit {
                ts: 1,
                project: "demo.mp4".to_string(),
                action: "autosave".to_string(),
                payload: "{\"cut\":3}".to_string(),
            },
        )
        .unwrap();
        let (project, action): (String, String) = conn
            .query_row("SELECT project, action FROM edit_actions", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(project, "demo.mp4");
        assert_eq!(action, "autosave");
    }

    #[test]
    fn kv_upserts_and_session_end_closes_once() {
        let conn = mem_db();
        insert(
            &conn,
            &Msg::Kv {
                key: "k".to_string(),
                value: "v1".to_string(),
            },
        )
        .unwrap();
        insert(
            &conn,
            &Msg::Kv {
                key: "k".to_string(),
                value: "v2".to_string(),
            },
        )
        .unwrap();
        let value: String = conn
            .query_row("SELECT value FROM kv WHERE key = 'k'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, "v2");

        conn.execute(
            "INSERT INTO sessions (started_at, app_version) VALUES (1, 'test')",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        insert(&conn, &Msg::SessionEnd { id }).unwrap();
        let first_ended: i64 = conn
            .query_row(
                "SELECT ended_at FROM sessions WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        insert(&conn, &Msg::SessionEnd { id }).unwrap();
        let (ended, clean): (i64, i64) = conn
            .query_row(
                "SELECT ended_at, clean_exit FROM sessions WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        // A second close must not rewrite the first stamp.
        assert_eq!(ended, first_ended);
        assert_eq!(clean, 1);
    }

    #[test]
    fn transfer_progress_updates_one_row() {
        let conn = mem_db();
        for done in [10, 100] {
            insert(
                &conn,
                &Msg::Transfer {
                    id: "t1".to_string(),
                    direction: "upload".to_string(),
                    total_bytes: 100,
                    done_bytes: done,
                    status: if done == 100 { "done" } else { "running" }.to_string(),
                },
            )
            .unwrap();
        }
        let (rows, done, status): (i64, i64, String) = conn
            .query_row(
                "SELECT COUNT(*), MAX(done_bytes), MAX(status) FROM vault_transfers",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(rows, 1, "the same id must update, not duplicate");
        assert_eq!(done, 100);
        assert_eq!(status, "done");
    }

    #[test]
    fn drop_legacy_tables_takes_only_the_telemetry_tables() {
        // A file that looks like the OLD app database: app tables and the
        // telemetry set side by side.
        let path = std::env::temp_dir().join(format!("t9-stats-drop-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE transcripts (
                     source_path TEXT NOT NULL,
                     id TEXT NOT NULL,
                     PRIMARY KEY (source_path, id)
                 );
                 INSERT INTO transcripts VALUES ('a.mp4', '1');",
            )
            .unwrap();
            conn.execute_batch(SCHEMA).unwrap();
        }

        drop_legacy_tables(&path);

        let conn = Connection::open(&path).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM transcripts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, 1, "the app's own tables must survive the sweep");
        for table in ALL_TABLES {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assert_eq!(exists, 0, "{table} should be gone as a legacy table");
        }
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }
}
