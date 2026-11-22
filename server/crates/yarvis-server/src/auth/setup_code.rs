//! The one-time code that creates the account, and the backup codes, which
//! share its shape.
//!
//! The server prints the setup code to stdout when it starts with no account,
//! and `yarvis-server auth reset` prints a new one. Whoever can read the
//! server's terminal can claim the server, which is the trust anchor for
//! everything after. The code lives in the database, as a SHA-256, so the CLI
//! and the running server see the same one.

use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

/// Wrong guesses allowed before the code is burned. A burned code needs a
/// restart or `auth reset` to replace, so an attacker gets 5 guesses at a
/// 10-character code (about 2^49 possibilities).
pub const ATTEMPTS: u8 = 5;

/// No 0/O, 1/I/L or U, so a code read off a terminal survives being retyped.
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTVWXYZ23456789";

pub type CodeHash = [u8; 32];

#[derive(Debug, PartialEq, Eq)]
pub enum CodeError {
    /// No code is outstanding: never issued, already used, or burned.
    NoCode,
    Wrong {
        attempts_left: u8,
    },
}

/// A random `XXXXX-XXXXX` code from [`ALPHABET`].
pub fn random_code() -> String {
    let mut rng = rand::rng();
    let chars: String = (0..10)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect();
    format!("{}-{}", &chars[..5], &chars[5..])
}

/// Case, dashes and spaces don't matter, so a code can be typed sloppily.
pub fn hash(code: &str) -> CodeHash {
    let normalized: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    Sha256::digest(normalized.as_bytes()).into()
}

/// Issues a code, replacing any outstanding one, and returns it in clear.
pub async fn issue(conn: &mut PgConnection) -> sqlx::Result<String> {
    let code = random_code();
    sqlx::query(
        "INSERT INTO setup_code (id, hash, attempts_left) VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, attempts_left = excluded.attempts_left",
    )
    .bind(hash(&code).to_vec())
    .bind(i32::from(ATTEMPTS))
    .execute(conn)
    .await?;
    Ok(code)
}

pub async fn clear(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM setup_code").execute(conn).await?;
    Ok(())
}

/// Checks a code without using it up, and counts a wrong guess. The row is
/// locked while it is checked, so two guesses at once each cost an attempt.
pub async fn check(
    conn: &mut PgConnection,
    given: &str,
) -> sqlx::Result<Result<CodeHash, CodeError>> {
    let given = hash(given);
    let mut tx = sqlx::Connection::begin(conn).await?;
    let row: Option<(Vec<u8>, i32)> =
        sqlx::query_as("SELECT hash, attempts_left FROM setup_code WHERE id = 1 FOR UPDATE")
            .fetch_optional(&mut *tx)
            .await?;
    let Some((stored, attempts_left)) = row else {
        return Ok(Err(CodeError::NoCode));
    };
    // Both sides are hashes, so how long the comparison takes says nothing
    // about how close the guess was.
    if stored == given {
        return Ok(Ok(given));
    }
    let attempts_left = u8::try_from(attempts_left).unwrap_or(0).saturating_sub(1);
    if attempts_left == 0 {
        sqlx::query("DELETE FROM setup_code")
            .execute(&mut *tx)
            .await?;
    } else {
        sqlx::query("UPDATE setup_code SET attempts_left = $1 WHERE id = 1")
            .bind(i32::from(attempts_left))
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Err(CodeError::Wrong { attempts_left }))
}

/// Uses up the code a setup started with. False if a parallel setup used it
/// first, or it was burned or replaced in the meantime.
pub async fn consume(conn: &mut PgConnection, code: &CodeHash) -> sqlx::Result<bool> {
    let deleted = sqlx::query("DELETE FROM setup_code WHERE id = 1 AND hash = $1")
        .bind(code.to_vec())
        .execute(conn)
        .await?;
    Ok(deleted.rows_affected() == 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Store, testing};

    async fn store() -> (Store, sqlx::pool::PoolConnection<sqlx::Postgres>) {
        let store = testing::store().await;
        let conn = store.db().unwrap().acquire().await.unwrap();
        (store, conn)
    }

    #[tokio::test]
    async fn a_code_is_case_and_dash_insensitive_and_single_use() {
        let (_store, mut conn) = store().await;
        let code = issue(&mut conn).await.unwrap();
        let sloppy = code.replace('-', " ").to_lowercase();
        let hash = check(&mut conn, &sloppy).await.unwrap().unwrap();
        assert!(consume(&mut conn, &hash).await.unwrap());
        assert!(!consume(&mut conn, &hash).await.unwrap());
        assert_eq!(
            check(&mut conn, &code).await.unwrap(),
            Err(CodeError::NoCode)
        );
    }

    #[tokio::test]
    async fn a_code_burns_after_too_many_wrong_guesses() {
        let (_store, mut conn) = store().await;
        let code = issue(&mut conn).await.unwrap();
        for left in (0..ATTEMPTS).rev() {
            assert_eq!(
                check(&mut conn, "AAAAA-AAAAA").await.unwrap(),
                Err(CodeError::Wrong {
                    attempts_left: left
                })
            );
        }
        assert_eq!(
            check(&mut conn, &code).await.unwrap(),
            Err(CodeError::NoCode)
        );
    }

    #[tokio::test]
    async fn a_new_code_replaces_the_old_one() {
        let (_store, mut conn) = store().await;
        let old = issue(&mut conn).await.unwrap();
        let new = issue(&mut conn).await.unwrap();
        assert!(matches!(
            check(&mut conn, &old).await.unwrap(),
            Err(CodeError::Wrong { .. })
        ));
        assert!(check(&mut conn, &new).await.unwrap().is_ok());
    }
}
