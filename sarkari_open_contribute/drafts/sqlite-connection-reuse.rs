// Draft sketch for PROPOSAL-20261021-OPENCODE-SQLITE-CONNECTION-REUSE
// Non-production. Review before applying.

use rusqlite::Connection;
use std::sync::Mutex;

pub struct DbState {
    pub conn: Mutex<Connection>,
}

pub fn open_once(path: &str) -> Result<DbState, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    Ok(DbState { conn: Mutex::new(conn) })
}
```