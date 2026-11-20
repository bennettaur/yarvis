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
    #[error(
        "the database has {found} migrations applied but this build knows {known}; run a newer yarvis-server"
    )]
    TooNew { found: i64, known: usize },
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
    /// Opens or creates the database. The data dir is made private (0700),
    /// since it holds the event log and, with the vault backend, the vault.
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        if let Some(dir) = path.parent() {
            create_private_dir(dir)?;
        }
        let store = Self::init(Connection::open(path)?)?;
        restrict_to_owner(path)?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        // A CLI run (`yarvis-server device add`) can open the file while the
        // server has it open, so wait for the lock rather than fail.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
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

fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    // One immediate transaction, with the version read inside it, so a
    // second process opening the file at the same time can't run a
    // migration twice.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let applied: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if applied as usize > MIGRATIONS.len() {
        return Err(StoreError::TooNew {
            found: applied,
            known: MIGRATIONS.len(),
        });
    }
    for sql in &MIGRATIONS[applied as usize..] {
        tx.execute_batch(sql)?;
    }
    tx.pragma_update(None, "user_version", MIGRATIONS.len() as i64)?;
    tx.commit()?;
    Ok(())
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    restrict_dir_to_owner(dir)
}

#[cfg(unix)]
fn restrict_dir_to_owner(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(unix)]
fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_dir_to_owner(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path) -> std::io::Result<()> {
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

    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.db");
        drop(Store::open(&path).unwrap());
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 999)
            .unwrap();
        assert!(matches!(
            Store::open(&path),
            Err(StoreError::TooNew { found: 999, .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn the_data_dir_and_database_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("nested").join("data");
        let path = data.join("server.db");
        drop(Store::open(&path).unwrap());
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data), 0o700);
        assert_eq!(mode(&path), 0o600);
    }
}
