//! The one-time code that registers the first passkey.
//!
//! The server prints it to stdout when it starts with no passkey. Whoever can
//! read the server's terminal can claim the server, which is the trust anchor
//! for everything after. Only a SHA-256 of the code is kept.

use rand::Rng;
use sha2::{Digest, Sha256};

/// Wrong guesses allowed before the code is burned. A burned code needs a
/// server restart to replace, so guessing gets 5 tries against about 2^49.
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

struct Outstanding {
    hash: CodeHash,
    attempts_left: u8,
}

#[derive(Default)]
pub struct SetupCode {
    code: Option<Outstanding>,
}

impl SetupCode {
    /// Issues a code, replacing any outstanding one, and returns it in clear.
    pub fn issue(&mut self) -> String {
        let mut rng = rand::rng();
        let chars: String = (0..10)
            .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
            .collect();
        let code = format!("{}-{}", &chars[..5], &chars[5..]);
        self.code = Some(Outstanding {
            hash: hash(&code),
            attempts_left: ATTEMPTS,
        });
        code
    }

    /// Checks a code without using it up, and counts a wrong guess.
    pub fn check(&mut self, given: &str) -> Result<CodeHash, CodeError> {
        let given = hash(given);
        let code = self.code.as_mut().ok_or(CodeError::NoCode)?;
        // Comparing hashes keeps timing from leaking how much of the code matched.
        if code.hash == given {
            return Ok(given);
        }
        code.attempts_left -= 1;
        let attempts_left = code.attempts_left;
        if attempts_left == 0 {
            self.code = None;
        }
        Err(CodeError::Wrong { attempts_left })
    }

    /// Uses up the code a ceremony started with. Fails if a parallel ceremony
    /// used it first, or it was burned in the meantime.
    pub fn consume(&mut self, hash: &CodeHash) -> bool {
        if self.code.as_ref().is_some_and(|c| c.hash == *hash) {
            self.code = None;
            true
        } else {
            false
        }
    }
}

/// Case, dashes and spaces don't matter, so the code can be typed sloppily.
fn hash(code: &str) -> CodeHash {
    let normalized: String = code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    Sha256::digest(normalized.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_case_and_dash_insensitive_and_single_use() {
        let mut codes = SetupCode::default();
        let code = codes.issue();
        let sloppy = code.replace('-', " ").to_lowercase();
        let hash = codes.check(&sloppy).unwrap();
        assert!(codes.consume(&hash));
        assert!(!codes.consume(&hash));
        assert_eq!(codes.check(&code), Err(CodeError::NoCode));
    }

    #[test]
    fn a_code_burns_after_too_many_wrong_guesses() {
        let mut codes = SetupCode::default();
        let code = codes.issue();
        for left in (0..ATTEMPTS).rev() {
            assert_eq!(
                codes.check("AAAAA-AAAAA"),
                Err(CodeError::Wrong {
                    attempts_left: left
                })
            );
        }
        assert_eq!(codes.check(&code), Err(CodeError::NoCode));
    }
}
