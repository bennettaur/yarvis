//! Copies the secrets blob from one store to another, for
//! `yarvis-server secrets migrate`.
//!
//! The source is only read, so it keeps its copy until the user removes it.
//! The destination is merged into rather than replaced, key by key, so a
//! provider or MCP server only it holds survives even inside a subtree both
//! have. Conflicts are named by dotted path; values are never part of any
//! message.

use serde_json::{Map, Value};

use crate::secret_blob::{self, Store, WriteGuard};

/// What to do with a key both stores hold with different values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnConflict {
    /// Copy nothing and report the keys.
    Refuse,
    /// The source's value replaces the destination's.
    SourceWins,
    /// The destination keeps its value.
    DestinationWins,
}

/// What a migration did, by dotted key path.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Migrated {
    /// Keys the destination didn't have.
    pub added: Vec<String>,
    /// Keys both held, where the source's value was written.
    pub replaced: Vec<String>,
    /// Keys both held, where the destination's value was kept.
    pub kept: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum MigrateError {
    /// Both stores hold these keys with different values, and the caller
    /// chose [`OnConflict::Refuse`]. Nothing was written.
    Conflicts(Vec<String>),
    /// The source store, by label, holds nothing to copy.
    SourceEmpty(String),
    /// The store, by label, holds text that isn't a JSON object. As a
    /// destination there is nothing to merge into, and overwriting it could
    /// lose what the user put there.
    NotSecrets(String),
    Store(String),
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflicts(keys) => {
                writeln!(
                    f,
                    "Nothing was copied. Both stores hold a different value for:"
                )?;
                for key in keys {
                    writeln!(f, "  {key}")?;
                }
                write!(
                    f,
                    "Run again with --force-source to take the source's values, or --force-dest \
                     to keep the destination's. Either way, keys only the source has are added."
                )
            }
            Self::SourceEmpty(label) => {
                write!(f, "{label} holds no secrets, so nothing was copied")
            }
            Self::NotSecrets(label) => write!(
                f,
                "{label} holds something that isn't Yarvis's secrets, so nothing was copied"
            ),
            Self::Store(message) => f.write_str(message),
        }
    }
}

/// The secrets `store` holds, as an object. Read raw, because the usual
/// parse turns unreadable text into an empty object: as a source that would
/// pass for "nothing to copy", and as a destination for "safe to overwrite".
pub fn read_secrets(store: &Store) -> Result<Map<String, Value>, MigrateError> {
    match store.read_raw().map_err(MigrateError::Store)? {
        None => Ok(Map::new()),
        Some(raw) if raw.trim().is_empty() => Ok(Map::new()),
        Some(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(map)) => Ok(map),
            _ => Err(MigrateError::NotSecrets(store.label.to_string())),
        },
    }
}

/// The secrets in `store`, refusing a store with none, for a caller that
/// wants to know there is something to copy before it prepares anything.
pub fn read_source(store: &Store) -> Result<Map<String, Value>, MigrateError> {
    let source = read_secrets(store)?;
    if source.is_empty() {
        return Err(MigrateError::SourceEmpty(store.label.to_string()));
    }
    Ok(source)
}

/// Merges the secrets in `from` into `to` under `guard`, writing `to` only
/// when something changes.
pub fn migrate(
    guard: &WriteGuard,
    from: &Store,
    to: &Store,
    on_conflict: OnConflict,
) -> Result<Migrated, MigrateError> {
    let source = read_source(from)?;
    let mut destination = read_secrets(to)?;
    let mut migrated = Migrated::default();
    // Merged in memory first: under `Refuse` every conflict lands in `kept`,
    // and nothing has been written yet.
    merge(&mut destination, &source, "", on_conflict, &mut migrated);
    if on_conflict == OnConflict::Refuse && !migrated.kept.is_empty() {
        return Err(MigrateError::Conflicts(migrated.kept));
    }
    if !migrated.added.is_empty() || !migrated.replaced.is_empty() {
        secret_blob::write_root_to(guard, to, &Value::Object(destination))
            .map_err(MigrateError::Store)?;
    }
    Ok(migrated)
}

fn merge(
    destination: &mut Map<String, Value>,
    source: &Map<String, Value>,
    prefix: &str,
    on_conflict: OnConflict,
    migrated: &mut Migrated,
) {
    for (key, value) in source {
        let path = join(prefix, key);
        match (destination.get_mut(key), value) {
            (None, _) => {
                destination.insert(key.clone(), value.clone());
                migrated.added.push(path);
            }
            (Some(Value::Object(inner)), Value::Object(from)) => {
                merge(inner, from, &path, on_conflict, migrated);
            }
            (Some(existing), _) if existing == value => {}
            (Some(existing), _) => {
                if on_conflict == OnConflict::SourceWins {
                    *existing = value.clone();
                    migrated.replaced.push(path);
                } else {
                    migrated.kept.push(path);
                }
            }
        }
    }
}

fn join(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;
    use crate::secret_blob::SecretBlob;
    use crate::secret_store::memory::MemoryBackend;
    use crate::settings::SettingsStore;

    fn store(label: &'static str, backend: &Arc<MemoryBackend>) -> Store {
        Store {
            label,
            backend: backend.clone(),
        }
    }

    fn contents(backend: &MemoryBackend) -> Value {
        serde_json::from_str(&backend.contents().unwrap()).unwrap()
    }

    /// Runs a migration under the real write lock, on a settings file of the
    /// test's own.
    fn run(
        from: &Arc<MemoryBackend>,
        to: &Arc<MemoryBackend>,
        on_conflict: OnConflict,
    ) -> Result<Migrated, MigrateError> {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsStore::new(dir.path().join("settings.json"));
        let to = store("destination", to);
        let blob = SecretBlob::with_store(to.clone(), settings);
        let guard = blob.lock_for_write().unwrap();
        migrate(&guard, &store("source", from), &to, on_conflict)
    }

    #[test]
    fn copies_everything_into_an_empty_store_and_leaves_the_source() {
        let source = r#"{"github_token":"gh","custom_providers":{"a":{"key":"k"}}}"#;
        let (from, to) = (MemoryBackend::holding(source), MemoryBackend::empty());

        let migrated = run(&from, &to, OnConflict::Refuse).unwrap();

        assert_eq!(migrated.added, ["custom_providers", "github_token"]);
        assert_eq!(
            contents(&to),
            serde_json::from_str::<Value>(source).unwrap()
        );
        assert!(from.writes().is_empty());
    }

    #[test]
    fn refuses_conflicting_keys_by_name_and_writes_nothing() {
        let from =
            MemoryBackend::holding(r#"{"github_token":"tok-source-123","jira_api_token":"j"}"#);
        let to = MemoryBackend::holding(
            r#"{"github_token":"tok-dest-456","custom_providers":{"a":{}}}"#,
        );

        let err = run(&from, &to, OnConflict::Refuse).unwrap_err();

        assert_eq!(err, MigrateError::Conflicts(vec!["github_token".into()]));
        let message = err.to_string();
        assert!(
            !message.contains("tok-source-123") && !message.contains("tok-dest-456"),
            "{message}"
        );
        assert!(to.writes().is_empty());
    }

    #[test]
    fn source_wins_replaces_conflicts_and_keeps_what_only_the_destination_has() {
        let from = MemoryBackend::holding(
            r#"{"github_token":"new","custom_providers":{"a":{"key":"k2"}}}"#,
        );
        let to = MemoryBackend::holding(
            r#"{"github_token":"old","custom_providers":{"a":{"key":"k1"},"b":{"key":"kb"}}}"#,
        );

        let migrated = run(&from, &to, OnConflict::SourceWins).unwrap();

        assert_eq!(
            migrated.replaced,
            ["custom_providers.a.key", "github_token"]
        );
        assert_eq!(
            contents(&to),
            json!({"github_token":"new","custom_providers":{"a":{"key":"k2"},"b":{"key":"kb"}}})
        );
    }

    #[test]
    fn destination_wins_keeps_conflicts_and_adds_what_it_lacks() {
        let from = MemoryBackend::holding(r#"{"github_token":"new","jira_api_token":"j"}"#);
        let to = MemoryBackend::holding(r#"{"github_token":"old"}"#);

        let migrated = run(&from, &to, OnConflict::DestinationWins).unwrap();

        assert_eq!(migrated.kept, ["github_token"]);
        assert_eq!(migrated.added, ["jira_api_token"]);
        assert_eq!(
            contents(&to),
            json!({"github_token":"old","jira_api_token":"j"})
        );
    }

    #[test]
    fn equal_values_are_not_conflicts_and_nothing_new_writes_nothing() {
        let from = MemoryBackend::holding(r#"{"github_token":"same"}"#);
        let to = MemoryBackend::holding(r#"{ "github_token": "same" }"#);

        let migrated = run(&from, &to, OnConflict::Refuse).unwrap();

        assert_eq!(migrated, Migrated::default());
        assert!(to.writes().is_empty());
    }

    #[test]
    fn a_destination_that_isnt_secrets_is_never_overwritten() {
        let from = MemoryBackend::holding(r#"{"github_token":"gh"}"#);
        let to = MemoryBackend::holding("notes typed by hand");

        for on_conflict in [OnConflict::Refuse, OnConflict::SourceWins] {
            let err = run(&from, &to, on_conflict).unwrap_err();
            assert_eq!(err, MigrateError::NotSecrets("destination".into()));
        }
        assert!(to.writes().is_empty());
    }

    #[test]
    fn an_empty_or_unparseable_source_is_reported_not_passed_off_as_copied() {
        let to = MemoryBackend::holding(r#"{"github_token":"gh"}"#);
        for (source, expected) in [
            (
                MemoryBackend::empty(),
                MigrateError::SourceEmpty("source".into()),
            ),
            (
                MemoryBackend::holding("{}"),
                MigrateError::SourceEmpty("source".into()),
            ),
            (
                MemoryBackend::holding("not json"),
                MigrateError::NotSecrets("source".into()),
            ),
        ] {
            assert_eq!(
                run(&source, &to, OnConflict::SourceWins).unwrap_err(),
                expected
            );
        }
        assert!(to.writes().is_empty());
    }

    #[test]
    fn destination_wins_inside_a_shared_subtree() {
        let from =
            MemoryBackend::holding(r#"{"custom_providers":{"a":{"key":"k2"},"b":{"key":"kb"}}}"#);
        let to = MemoryBackend::holding(r#"{"custom_providers":{"a":{"key":"k1"}}}"#);

        let migrated = run(&from, &to, OnConflict::DestinationWins).unwrap();

        assert_eq!(migrated.kept, ["custom_providers.a.key"]);
        assert_eq!(migrated.added, ["custom_providers.b"]);
        assert_eq!(
            contents(&to),
            json!({"custom_providers":{"a":{"key":"k1"},"b":{"key":"kb"}}})
        );
    }

    #[test]
    fn a_value_against_a_subtree_is_one_conflict_resolved_whole() {
        let from = MemoryBackend::holding(r#"{"mcp_servers":"flat","github_token":{"x":1}}"#);
        let to = MemoryBackend::holding(r#"{"mcp_servers":{"s":{"t":"v"}},"github_token":"gh"}"#);

        assert_eq!(
            run(&from, &to, OnConflict::Refuse).unwrap_err(),
            MigrateError::Conflicts(vec!["github_token".into(), "mcp_servers".into()])
        );
        run(&from, &to, OnConflict::SourceWins).unwrap();
        assert_eq!(
            contents(&to),
            json!({"mcp_servers":"flat","github_token":{"x":1}})
        );
    }

    #[test]
    fn the_conflict_message_lists_every_path_and_how_to_go_on() {
        let message = MigrateError::Conflicts(vec!["a.b".into(), "c".into()]).to_string();
        assert!(message.contains("  a.b\n  c\n"), "{message}");
        assert!(message.contains("--force-source") && message.contains("--force-dest"));
    }

    #[test]
    fn a_source_that_cant_be_read_copies_nothing() {
        let (from, to) = (MemoryBackend::unreadable(), MemoryBackend::empty());

        assert!(matches!(
            run(&from, &to, OnConflict::SourceWins),
            Err(MigrateError::Store(_))
        ));
        assert!(to.writes().is_empty());
    }
}
