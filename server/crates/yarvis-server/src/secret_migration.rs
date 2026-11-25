//! Copies the secrets blob from one store to another, for
//! `yarvis-server secrets migrate`.
//!
//! The source is only read, so it keeps its copy until the user removes it.
//! The destination is merged into rather than replaced: a key only it holds is
//! kept, and a key both hold with different values is a conflict. Conflicts
//! stop the copy unless the caller says which side wins.
//!
//! Objects are merged key by key, so a provider or MCP server that only the
//! destination has survives even when both hold the same subtree. Conflicts
//! are named by dotted path, and values are never part of any message.

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
    /// The destination holds text that isn't a JSON object, so there is
    /// nothing to merge into and overwriting it could lose what the user put
    /// there.
    DestinationNotSecrets(String),
    Store(String),
}

impl std::fmt::Display for MigrateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflicts(keys) => write!(
                f,
                "both stores hold different values for: {}",
                keys.join(", ")
            ),
            Self::DestinationNotSecrets(label) => write!(
                f,
                "{label} holds something that isn't Yarvis's secrets, so nothing was copied"
            ),
            Self::Store(message) => f.write_str(message),
        }
    }
}

/// Merges the secrets in `from` into `to` under `guard`, writing `to` only
/// when something changes.
pub fn migrate(
    guard: &WriteGuard,
    from: &Store,
    to: &Store,
    on_conflict: OnConflict,
) -> Result<Migrated, MigrateError> {
    let source = secret_blob::read_root_from(from).map_err(MigrateError::Store)?;
    // Read raw: unparseable text would otherwise look like an empty store
    // and be overwritten.
    let mut destination = match to.read_raw().map_err(MigrateError::Store)? {
        None => Value::Object(Map::new()),
        Some(raw) if raw.trim().is_empty() => Value::Object(Map::new()),
        Some(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(value @ Value::Object(_)) => value,
            _ => return Err(MigrateError::DestinationNotSecrets(to.label.to_string())),
        },
    };
    let Value::Object(source) = source else {
        return Err(MigrateError::Store(format!(
            "{} holds something that isn't Yarvis's secrets",
            from.label
        )));
    };

    let conflicts = conflicting_paths(&source, destination.as_object().expect("checked above"));
    if on_conflict == OnConflict::Refuse && !conflicts.is_empty() {
        return Err(MigrateError::Conflicts(conflicts));
    }
    let mut migrated = Migrated::default();
    merge(
        destination.as_object_mut().expect("checked above"),
        &source,
        "",
        on_conflict,
        &mut migrated,
    );
    if !migrated.added.is_empty() || !migrated.replaced.is_empty() {
        secret_blob::write_root_to(guard, to, &destination).map_err(MigrateError::Store)?;
    }
    Ok(migrated)
}

/// The paths where both hold a value and the values differ. Two objects are
/// walked into rather than compared whole.
fn conflicting_paths(source: &Map<String, Value>, destination: &Map<String, Value>) -> Vec<String> {
    let mut found = Vec::new();
    walk_conflicts(source, destination, "", &mut found);
    found
}

fn walk_conflicts(
    source: &Map<String, Value>,
    destination: &Map<String, Value>,
    prefix: &str,
    found: &mut Vec<String>,
) {
    for (key, value) in source {
        let path = join(prefix, key);
        match (value, destination.get(key)) {
            (_, None) => {}
            (Value::Object(a), Some(Value::Object(b))) => walk_conflicts(a, b, &path, found),
            (a, Some(b)) if a != b => found.push(path),
            _ => {}
        }
    }
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
            assert_eq!(
                err,
                MigrateError::DestinationNotSecrets("destination".into())
            );
        }
        assert!(to.writes().is_empty());
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
