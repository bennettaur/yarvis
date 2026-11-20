//! The server's own SQLite database: devices, events, and whatever else the
//! server owns. Postgres stays the sidecar's. Auth must work while Postgres is
//! down, so nothing here depends on it.
//!
//! One connection behind a mutex. The server's write rate is a person's
//! clicks plus PTY-free bookkeeping, so a pool would only add lock contention
//! inside SQLite. Calls run on the blocking pool so a slow disk never stalls
//! the async workers.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
    #[error("couldn't create the data dir: {0}")]
    Io(#[from] std::io::Error),
}

/// Migrations run in order, once each. Append to the end; never edit one that
/// has shipped, since `user_version` records how many have already run.
/// A module that owns tables adds its own entry here.
const MIGRATIONS: &[&str] = &[
    // 1: devices and the event log.
    r#"
    CREATE TABLE devices (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('passkey', 'token')),
        scopes        TEXT NOT NULL,
        token_hash    BLOB NOT NULL UNIQUE,
        passkey_id    TEXT,
        created_by    TEXT,
        user_agent    TEXT,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER,
        verified_at   INTEGER,
        revoked_at    INTEGER
    );
    CREATE TABLE events (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        at         INTEGER NOT NULL,
        device_id  TEXT,
        kind       TEXT NOT NULL,
        data       TEXT NOT NULL
    );
    "#,
];

#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// Runs `f` with the connection on the blocking pool.
    pub async fn call<T, F>(&self, f: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        let result = tokio::task::spawn_blocking(move || {
            // A panic while holding the lock can't leave a half-applied write,
            // since SQLite rolls back the open transaction, so carry on.
            let mut conn = conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            f(&mut conn)
        })
        .await?;
        Ok(result?)
    }
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let done: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(done as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_a_database_runs_no_migration_twice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.db");
        drop(Store::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
        drop(conn);
        // A second open would fail on `CREATE TABLE devices` if it re-ran.
        Store::open(&path).unwrap();
    }
}
