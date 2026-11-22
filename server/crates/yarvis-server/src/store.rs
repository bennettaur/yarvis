//! The server's own tables: the account, devices, events and approvals. They
//! live in the `yarvis_server` schema of the Postgres database the sidecar
//! uses, so there is one datastore to run and back up. Drizzle owns `public`
//! and never sees this schema. With Postgres down, nothing here works, and so
//! nobody can sign in or unlock the vault until it is back.
//!
//! Every pooled connection has `search_path` set to the schema, so queries
//! name tables bare. [`SCHEMA`] is the default; `[database] schema` in
//! `server.toml` picks another, so a dev instance or a test can share the
//! database without sharing an account.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use sqlx::migrate::{Migration, MigrationType, Migrator};
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions};
use sqlx::{Executor, Postgres, SqlSafeStr, Transaction};

pub const SCHEMA: &str = "yarvis_server";

/// Long enough for a slow query to get a connection, short enough that a
/// request fails with 503 soon after Postgres goes away.
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_CONNECTIONS: u32 = 8;

/// The cap on `migrate_with_retry`'s doubling delay between tries.
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("the database isn't reachable")]
    Unavailable,
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("database migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    /// A blocking task (passphrase hashing, say) panicked or was cancelled.
    #[error("a background task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
    #[error("{0}")]
    Config(String),
}

impl StoreError {
    /// Postgres is down or unreachable, rather than a query being wrong. The
    /// API answers these with 503 so a client retries instead of giving up.
    pub fn is_unavailable(&self) -> bool {
        match self {
            Self::Unavailable => true,
            Self::Db(e)
            | Self::Migrate(
                sqlx::migrate::MigrateError::Execute(e)
                | sqlx::migrate::MigrateError::ExecuteMigration(e, _),
            ) => is_connection_error(e),
            _ => false,
        }
    }
}

/// Errors the user fixes outside the server (start Postgres, create the
/// database, correct the password), after which a retry succeeds.
fn is_connection_error(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::PoolTimedOut
        | sqlx::Error::PoolClosed
        | sqlx::Error::Io(_)
        | sqlx::Error::Tls(_) => true,
        // Class 08 is a connection failure, 28 a refused login, 3D000 a
        // database that doesn't exist, 53300 too many connections, and 57P
        // Postgres starting up or shutting down (a restart, say).
        sqlx::Error::Database(db) => db.code().is_some_and(|code| {
            code.starts_with("08")
                || code.starts_with("28")
                || code.starts_with("57P")
                || code == "3D000"
                || code == "53300"
        }),
        _ => false,
    }
}

/// Migrations run in order, once each, recorded in the schema's own
/// `_sqlx_migrations` table. Append to the end; never edit one that has
/// shipped, since its checksum is stored.
const MIGRATIONS: &[(i64, &str, &str)] = &[(
    1,
    "devices, events, the account, setup code and approvals",
    include_str!("../migrations/0001_init.sql"),
)];

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
    schema: Arc<str>,
    /// Set once the migrations have run. Until then every query is refused
    /// with [`StoreError::Unavailable`], so nothing reads a half-made schema.
    ready: Arc<AtomicBool>,
}

impl Store {
    /// A store that connects on first use. Nothing touches the network here,
    /// so a server can start listening before Postgres is up; run
    /// [`Store::migrate`] (or [`Store::migrate_with_retry`]) before using it.
    pub fn connect_lazy(url: &str, schema: &str) -> Result<Self, StoreError> {
        check_schema_name(schema)?;
        let options: PgConnectOptions = url.parse().map_err(|_| {
            StoreError::Config("the database URL isn't a valid postgres:// URL".into())
        })?;
        let set_path = format!("SET search_path TO \"{schema}\"");
        let pool = PgPoolOptions::new()
            .max_connections(MAX_CONNECTIONS)
            .acquire_timeout(ACQUIRE_TIMEOUT)
            .after_connect(move |conn, _| {
                let set_path = set_path.clone();
                Box::pin(async move {
                    conn.execute(sqlx::AssertSqlSafe(set_path)).await?;
                    Ok(())
                })
            })
            .connect_lazy_with(options);
        Ok(Self {
            pool,
            schema: schema.into(),
            ready: Arc::default(),
        })
    }

    /// Connects and migrates, failing at once if Postgres isn't there.
    pub async fn connect(url: &str, schema: &str) -> Result<Self, StoreError> {
        let store = Self::connect_lazy(url, schema)?;
        store.migrate().await?;
        Ok(store)
    }

    /// Migrates, retrying with backoff while Postgres is unreachable, as it
    /// is for a moment when launchd starts the server at boot. Gives up after
    /// `limit`, or never without one. Any other failure returns at once.
    pub async fn migrate_with_retry(&self, limit: Option<Duration>) -> Result<(), StoreError> {
        let deadline = limit.map(|limit| tokio::time::Instant::now() + limit);
        let mut delay = Duration::from_secs(1);
        loop {
            match self.migrate().await {
                Ok(()) => return Ok(()),
                Err(e) if e.is_unavailable() => {
                    if deadline.is_some_and(|d| tokio::time::Instant::now() + delay > d) {
                        return Err(e);
                    }
                    tracing::warn!("waiting for the database: {e}; retrying in {delay:?}");
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(MAX_RETRY_DELAY);
                }
                Err(e) => return Err(e),
            }
        }
    }

    /// Creates the schema and runs any migration not yet applied. Safe to run
    /// from two processes at once: sqlx holds an advisory lock while it runs.
    pub async fn migrate(&self) -> Result<(), StoreError> {
        let mut migrator = Migrator::with_migrations(
            MIGRATIONS
                .iter()
                .map(|(version, description, sql)| {
                    Migration::new(
                        *version,
                        (*description).into(),
                        MigrationType::Simple,
                        sqlx::AssertSqlSafe(*sql).into_sql_str(),
                        false,
                    )
                })
                .collect(),
        );
        migrator.create_schema(self.schema.to_string());
        // Schema-qualified, so the table never lands in `public` beside Drizzle's.
        migrator.dangerous_set_table_name(format!("\"{}\"._sqlx_migrations", self.schema));
        migrator.run(&self.pool).await?;
        self.ready.store(true, Ordering::Release);
        Ok(())
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    /// The pool, once migrated.
    pub fn db(&self) -> Result<&PgPool, StoreError> {
        if self.is_ready() {
            Ok(&self.pool)
        } else {
            Err(StoreError::Unavailable)
        }
    }

    pub async fn begin(&self) -> Result<Transaction<'static, Postgres>, StoreError> {
        Ok(self.db()?.begin().await?)
    }

    pub fn schema(&self) -> &str {
        &self.schema
    }
}

/// The schema name goes into SQL unescaped, so only plain names are allowed.
/// `public` is Drizzle's, which a `drizzle-kit push` may rewrite, and `pg_`
/// names belong to Postgres.
fn check_schema_name(schema: &str) -> Result<(), StoreError> {
    let plain = !schema.is_empty()
        && schema != "public"
        && !schema.starts_with("pg_")
        && schema.len() <= 63
        && schema.starts_with(|c: char| c.is_ascii_lowercase() || c == '_')
        && schema
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if plain {
        Ok(())
    } else {
        Err(StoreError::Config(format!(
            "{schema:?} isn't a plain schema name"
        )))
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Stores on a schema of their own in `TEST_DATABASE_URL`, for tests.
#[doc(hidden)]
pub mod testing {
    use super::*;

    /// Schemas older than this are dropped when a test starts, so the ones a
    /// finished run left behind don't pile up.
    const STALE_AFTER_MS: i64 = 60 * 60 * 1000;

    pub fn test_database_url() -> String {
        std::env::var("TEST_DATABASE_URL").unwrap_or_else(|_| {
            panic!(
                "set TEST_DATABASE_URL to a Postgres database the tests may create schemas in, \
                 such as postgres://localhost:5432/yarvis_test"
            )
        })
    }

    /// A migrated store on a new, empty schema.
    pub async fn store() -> Store {
        let schema = new_schema().await;
        Store::connect(&test_database_url(), &schema)
            .await
            .expect("couldn't open the test database")
    }

    /// A fresh schema's name, for tests that open several stores on one
    /// schema, as two processes would.
    pub async fn new_schema() -> String {
        drop_stale_schemas().await;
        let mut suffix = [0u8; 6];
        rand::RngCore::fill_bytes(&mut rand::rng(), &mut suffix);
        let suffix: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
        format!("yarvis_test_{}_{suffix}", now_ms())
    }

    /// Best effort: a schema left behind only costs space, so any failure
    /// here is ignored. Reads the time `new_schema` puts after the prefix.
    async fn drop_stale_schemas() {
        let Ok(pool) = PgPool::connect(&test_database_url()).await else {
            return;
        };
        let schemas: Vec<String> = sqlx::query_scalar(
            "SELECT nspname::text FROM pg_namespace WHERE nspname LIKE 'yarvis\\_test\\_%'",
        )
        .fetch_all(&pool)
        .await
        .unwrap_or_default();
        let cutoff = now_ms() - STALE_AFTER_MS;
        for schema in schemas {
            let created = schema
                .strip_prefix("yarvis_test_")
                .and_then(|rest| rest.split('_').next())
                .and_then(|ms| ms.parse::<i64>().ok());
            if created.is_some_and(|ms| ms < cutoff) && check_schema_name(&schema).is_ok() {
                let _ = pool
                    .execute(sqlx::AssertSqlSafe(format!(
                        "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
                    )))
                    .await;
            }
        }
        pool.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migrating_twice_runs_no_migration_twice() {
        let schema = testing::new_schema().await;
        let url = testing::test_database_url();
        let store = Store::connect(&url, &schema).await.unwrap();
        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(store.db().unwrap())
            .await
            .unwrap();
        assert_eq!(applied as usize, MIGRATIONS.len());
        // A second run would fail on `CREATE TABLE devices` if it re-ran.
        Store::connect(&url, &schema).await.unwrap();
    }

    /// The server and a CLI command can start together on a new schema.
    #[tokio::test]
    async fn two_processes_migrating_at_once_both_succeed() {
        let schema = testing::new_schema().await;
        let url = testing::test_database_url();
        let (one, two, three) = tokio::join!(
            Store::connect(&url, &schema),
            Store::connect(&url, &schema),
            Store::connect(&url, &schema),
        );
        let store = one.unwrap();
        two.unwrap();
        three.unwrap();
        let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(store.db().unwrap())
            .await
            .unwrap();
        assert_eq!(applied as usize, MIGRATIONS.len());
    }

    #[tokio::test]
    async fn the_migrations_table_and_tables_stay_in_the_schema() {
        let store = testing::store().await;
        let inside: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_name IN ('_sqlx_migrations', 'devices', 'events', 'account')
               AND table_schema = $1",
        )
        .bind(store.schema())
        .fetch_one(store.db().unwrap())
        .await
        .unwrap();
        assert_eq!(inside, 4);
        // Another test's schema may hold these names, but `public` never does.
        let in_public: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.tables
             WHERE table_name = '_sqlx_migrations' AND table_schema = 'public'",
        )
        .fetch_one(store.db().unwrap())
        .await
        .unwrap();
        assert_eq!(in_public, 0);
    }

    #[tokio::test]
    async fn a_database_from_a_newer_build_is_refused() {
        let schema = testing::new_schema().await;
        let url = testing::test_database_url();
        let store = Store::connect(&url, &schema).await.unwrap();
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (999, 'from the future', true, '\\x00', 0)",
        )
        .execute(store.db().unwrap())
        .await
        .unwrap();
        assert!(matches!(
            Store::connect(&url, &schema).await,
            Err(StoreError::Migrate(
                sqlx::migrate::MigrateError::VersionMissing(999)
            ))
        ));
    }

    #[tokio::test]
    async fn a_store_refuses_queries_until_migrated() {
        let store = Store::connect_lazy(&testing::test_database_url(), "yarvis_unused").unwrap();
        assert!(matches!(store.db(), Err(StoreError::Unavailable)));
        assert!(StoreError::Unavailable.is_unavailable());
    }

    #[tokio::test]
    async fn an_unreachable_database_is_unavailable_not_a_crash() {
        // Port 1 on loopback refuses connections.
        let store = Store::connect_lazy("postgres://127.0.0.1:1/x", SCHEMA).unwrap();
        let err = store
            .migrate_with_retry(Some(Duration::from_millis(10)))
            .await
            .unwrap_err();
        assert!(err.is_unavailable(), "{err}");
    }

    #[tokio::test]
    async fn a_missing_database_is_waited_for_like_a_stopped_server() {
        let mut url = url::Url::parse(&testing::test_database_url()).unwrap();
        url.set_path("/yarvis_no_such_database");
        let store = Store::connect_lazy(url.as_str(), SCHEMA).unwrap();
        let err = store.migrate().await.unwrap_err();
        assert!(err.is_unavailable(), "{err}");
    }

    #[test]
    fn only_plain_schema_names_are_allowed() {
        assert!(check_schema_name("yarvis_server").is_ok());
        for bad in [
            "",
            "Upper",
            "a-b",
            "a\"b",
            "1abc",
            "a;drop",
            "public",
            "pg_catalog",
        ] {
            assert!(check_schema_name(bad).is_err(), "{bad}");
        }
    }
}
