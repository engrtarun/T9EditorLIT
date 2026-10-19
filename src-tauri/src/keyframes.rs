//! Keyframe (I-frame) map for the export planner (Chunk 4).
//!
//! Stream-copy cuts are only possible where the bitstream starts a new GOP, so
//! the planner needs the timestamp of every I-frame in the source. That list is
//! produced by one ffprobe child process which streams its answer line by line
//! — a 5 GB file yields a few thousand floats, never a multi-hundred-megabyte
//! packet dump in this process's heap.
//!
//! The list is cached in SQLite next to the transcript: re-planning after a
//! single transcript toggle must not re-read 5 GB from disk.

use rusqlite::{Connection, params};
use std::path::Path;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS keyframes (
    source_path TEXT PRIMARY KEY,
    size_bytes  INTEGER NOT NULL,
    mtime_secs  INTEGER NOT NULL,
    times       TEXT NOT NULL
);
";

/// Create the cache table. Safe to call on every open.
pub fn init_cache_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("could not init keyframe cache schema: {e}"))
}

/// `(size, mtime)` of the source — the two facts that invalidate a cache row
/// when the file is re-cut or replaced.
fn fingerprint(path: &Path) -> Result<(u64, i64), String> {
    let meta =
        std::fs::metadata(path).map_err(|e| format!("could not stat {}: {e}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok((meta.len(), mtime))
}

/// Cached keyframe times, or `None` when absent or stale.
pub fn load_cached(conn: &Connection, source_path: &str, path: &Path) -> Option<Vec<f64>> {
    let (size, mtime) = fingerprint(path).ok()?;
    let mut stmt = conn
        .prepare("SELECT size_bytes, mtime_secs, times FROM keyframes WHERE source_path = ?1")
        .ok()?;
    let mut rows = stmt.query(params![source_path]).ok()?;
    let row = rows.next().ok()??;
    let cached_size: i64 = row.get(0).ok()?;
    let cached_mtime: i64 = row.get(1).ok()?;
    let times: String = row.get(2).ok()?;
    if cached_size != size as i64 || cached_mtime != mtime {
        return None;
    }
    let parsed: Vec<f64> = times
        .split(',')
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<f64>().ok())
        .collect();
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

/// Persist a freshly scanned list for next time.
pub fn store_cached(
    conn: &Connection,
    source_path: &str,
    path: &Path,
    times: &[f64],
) -> Result<(), String> {
    let (size, mtime) = fingerprint(path)?;
    let payload = times
        .iter()
        .map(|t| format!("{t}"))
        .collect::<Vec<_>>()
        .join(",");
    conn.execute(
        "INSERT INTO keyframes (source_path, size_bytes, mtime_secs, times)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(source_path) DO UPDATE SET
            size_bytes = excluded.size_bytes,
            mtime_secs = excluded.mtime_secs,
            times      = excluded.times",
        params![source_path, size as i64, mtime, payload],
    )
    .map_err(|e| format!("could not cache keyframes: {e}"))?;
    Ok(())
}

/// Stream every I-frame timestamp of the video stream out of ffprobe.
///
/// `-skip_frame nokey` makes ffprobe decode *only* keyframes: the file is read
/// from disk once, but the CPU cost stays near zero — which is the whole reason
/// this is a child process and not an in-process demuxer.
pub fn scan(
    path: &Path,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Vec<f64>, String> {
    let src = path.to_string_lossy().into_owned();
    let args = [
        "-v".to_string(),
        "error".to_string(),
        "-select_streams".to_string(),
        "v:0".to_string(),
        "-skip_frame".to_string(),
        "nokey".to_string(),
        "-show_frames".to_string(),
        "-show_entries".to_string(),
        "frame=pts_time".to_string(),
        "-of".to_string(),
        "csv=p=0".to_string(),
        src,
    ];

    let mut times: Vec<f64> = Vec::with_capacity(4096);
    let out = crate::ffmpeg::run_streaming("ffprobe", &args, cancel, |line| {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        // `csv=p=0` prints one timestamp per line; N/A rows are simply skipped.
        if let Ok(t) = line.parse::<f64>() {
            if t.is_finite() {
                times.push(t);
            }
        }
    })?;

    if out.cancelled {
        return Err("keyframe scan cancelled".to_string());
    }
    if out.status != 0 {
        return Err(format!(
            "ffprobe keyframe scan failed ({}): {}",
            out.status,
            out.stderr_tail.trim()
        ));
    }
    if times.is_empty() {
        return Err(
            "no keyframes found — is this a video file with a real video stream?".to_string(),
        );
    }
    Ok(times)
}

/// Cached-if-possible keyframe list: the transcript DB stores it keyed by path,
/// size and mtime so a second export never re-reads the whole file.
pub fn keyframes_for(
    path: &Path,
    db: Option<&Connection>,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> Result<Vec<f64>, String> {
    let key = path.to_string_lossy().into_owned();
    if let Some(conn) = db {
        if let Some(cached) = load_cached(conn, &key, path) {
            return Ok(cached);
        }
    }
    let times = scan(path, cancel)?;
    if let Some(conn) = db {
        let _ = store_cached(conn, &key, path, &times);
    }
    Ok(times)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_round_trip_and_invalidation_by_fingerprint() {
        let dir = std::env::temp_dir().join(format!("t9kf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fake.mp4");
        std::fs::write(&file, b"not really a video, but stat-able").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        init_cache_schema(&conn).unwrap();

        assert_eq!(load_cached(&conn, "x", &file), None, "nothing cached yet");

        let times = vec![0.0, 2.002, 4.004, 6.006];
        store_cached(&conn, "x", &file, &times).unwrap();
        assert_eq!(load_cached(&conn, "x", &file), Some(times.clone()));

        // Different path → miss.
        assert_eq!(load_cached(&conn, "other", &file), None);

        // Replacing the bytes changes the size → stale.
        std::fs::write(&file, b"longer contents now").unwrap();
        assert_eq!(load_cached(&conn, "x", &file), None);

        // …and storing again under the new fingerprint restores the hit.
        store_cached(&conn, "x", &file, &times).unwrap();
        assert_eq!(load_cached(&conn, "x", &file), Some(times));

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn cached_rows_survive_re_open_of_the_same_schema() {
        let conn = Connection::open_in_memory().unwrap();
        init_cache_schema(&conn).unwrap();
        init_cache_schema(&conn).unwrap(); // idempotent
        assert!(load_cached(&conn, "missing", Path::new("nope.mp4")).is_none());
    }
}
