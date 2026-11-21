//! The one-time code that creates the account, and the backup codes, which
//! share its shape.
//!
//! The server prints the setup code to stdout when it starts with no account,
//! and `yarvis-server auth reset` prints a new one. Whoever can read the
//! server's terminal can claim the server, which is the trust anchor for
//! everything after. The code lives in SQLite, as a SHA-256, so the CLI and the
//! running server see the same one.

use rand::Rng;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

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
pub fn issue(conn: &Connection) -> rusqlite::Result<String> {
    let code = random_code();
    conn.execute(
        "INSERT INTO setup_code (id, hash, attempts_left) VALUES (1, ?1, ?2)
         ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, attempts_left = excluded.attempts_left",
        rusqlite::params![hash(&code).to_vec(), ATTEMPTS],
    )?;
    Ok(code)
}

pub fn clear(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM setup_code", [])?;
    Ok(())
}

/// Checks a code without using it up, and counts a wrong guess.
pub fn check(conn: &mut Connection, given: &str) -> rusqlite::Result<Result<CodeHash, CodeError>> {
    let given = hash(given);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let row: Option<(Vec<u8>, u8)> = tx
        .query_row(
            "SELECT hash, attempts_left FROM setup_code WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((stored, attempts_left)) = row else {
        return Ok(Err(CodeError::NoCode));
    };
    // Both sides are hashes, so how long the comparison takes says nothing
    // about how close the guess was.
    if stored == given {
        return Ok(Ok(given));
    }
    let attempts_left = attempts_left.saturating_sub(1);
    if attempts_left == 0 {
        tx.execute("DELETE FROM setup_code", [])?;
    } else {
        tx.execute(
            "UPDATE setup_code SET attempts_left = ?1 WHERE id = 1",
            [attempts_left],
        )?;
    }
    tx.commit()?;
    Ok(Err(CodeError::Wrong { attempts_left }))
}

/// Uses up the code a setup started with. False if a parallel setup used it
/// first, or it was burned or replaced in the meantime.
pub fn consume(conn: &Connection, code: &CodeHash) -> rusqlite::Result<bool> {
    Ok(conn.execute(
        "DELETE FROM setup_code WHERE id = 1 AND hash = ?1",
        [code.to_vec()],
    )? == 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The table as the store's migration makes it.
    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE setup_code (id INTEGER PRIMARY KEY CHECK (id = 1), hash BLOB NOT NULL, attempts_left INTEGER NOT NULL)",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_code_is_case_and_dash_insensitive_and_single_use() {
        let mut conn = conn();
        let code = issue(&conn).unwrap();
        let sloppy = code.replace('-', " ").to_lowercase();
        let hash = check(&mut conn, &sloppy).unwrap().unwrap();
        assert!(consume(&conn, &hash).unwrap());
        assert!(!consume(&conn, &hash).unwrap());
        assert_eq!(check(&mut conn, &code).unwrap(), Err(CodeError::NoCode));
    }

    #[test]
    fn a_code_burns_after_too_many_wrong_guesses() {
        let mut conn = conn();
        let code = issue(&conn).unwrap();
        for left in (0..ATTEMPTS).rev() {
            assert_eq!(
                check(&mut conn, "AAAAA-AAAAA").unwrap(),
                Err(CodeError::Wrong {
                    attempts_left: left
                })
            );
        }
        assert_eq!(check(&mut conn, &code).unwrap(), Err(CodeError::NoCode));
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let mut conn = conn();
        let old = issue(&conn).unwrap();
        let new = issue(&conn).unwrap();
        assert!(matches!(
            check(&mut conn, &old).unwrap(),
            Err(CodeError::Wrong { .. })
        ));
        assert!(check(&mut conn, &new).unwrap().is_ok());
    }
}
