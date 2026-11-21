//! Time-based one-time codes (RFC 6238): HMAC-SHA1, 6 digits, 30-second steps,
//! the parameters every authenticator app defaults to.

use hmac::{Hmac, Mac};
use rand::RngCore;
use sha1::Sha1;
use zeroize::Zeroizing;

pub const STEP_MS: i64 = 30_000;
pub const DIGITS: u32 = 6;
/// Steps either side of now a code may come from, for a phone whose clock is
/// a little off or a code typed just as it rolls over.
const TOLERANCE: i64 = 1;
/// 160 bits, the size RFC 4226 recommends for an HMAC-SHA1 key.
const SECRET_LEN: usize = 20;

pub fn new_secret() -> Zeroizing<Vec<u8>> {
    let mut secret = Zeroizing::new(vec![0u8; SECRET_LEN]);
    rand::rng().fill_bytes(&mut secret);
    secret
}

pub fn step_at(now_ms: i64) -> i64 {
    now_ms.div_euclid(STEP_MS)
}

/// The code for one step (RFC 4226's HOTP with the step as the counter).
pub fn code_at(secret: &[u8], step: i64, digits: u32) -> u32 {
    let mut mac = Hmac::<Sha1>::new_from_slice(secret).expect("HMAC takes any key length");
    mac.update(&(step as u64).to_be_bytes());
    let hash = mac.finalize().into_bytes();
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let truncated = u32::from_be_bytes([
        hash[offset] & 0x7f,
        hash[offset + 1],
        hash[offset + 2],
        hash[offset + 3],
    ]);
    truncated % 10u32.pow(digits)
}

/// The step `code` matches within the tolerance around `now_step`, taking only
/// steps after `last_step` so an accepted code can't be used again. Every
/// candidate is checked, so the time taken doesn't say which one matched.
pub fn matching_step(
    secret: &[u8],
    code: &str,
    now_step: i64,
    last_step: Option<i64>,
) -> Option<i64> {
    let code = code.trim();
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let mut found = None;
    for step in now_step - TOLERANCE..=now_step + TOLERANCE {
        let expected = format!(
            "{:0width$}",
            code_at(secret, step, DIGITS),
            width = DIGITS as usize
        );
        let fresh = last_step.is_none_or(|last| step > last);
        if constant_time_eq(expected.as_bytes(), code.as_bytes()) && fresh && found.is_none() {
            found = Some(step);
        }
    }
    found
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// RFC 4648 base32 without padding, which authenticator apps take as the secret.
pub fn base32(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for &byte in bytes {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The `otpauth://` URI authenticator apps read from a QR code.
pub fn otpauth_uri(secret_base32: &str) -> String {
    format!(
        "otpauth://totp/Yarvis:yarvis-server?secret={secret_base32}&issuer=Yarvis&algorithm=SHA1&digits={DIGITS}&period={}",
        STEP_MS / 1000
    )
}

/// The URI as a QR code, in SVG, for the setup screen to show as an image.
pub fn qr_svg(uri: &str) -> String {
    qrcode::QrCode::new(uri.as_bytes())
        .expect("an otpauth URI fits in a QR code")
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B, SHA-1 rows: the 20-byte ASCII secret, 8 digits.
    #[test]
    fn matches_the_rfc_6238_test_vectors() {
        let secret = b"12345678901234567890";
        for (seconds, code) in [
            (59, 94287082),
            (1111111109, 7081804),
            (1111111111, 14050471),
            (1234567890, 89005924),
            (2000000000, 69279037),
            (20000000000, 65353130),
        ] {
            assert_eq!(code_at(secret, seconds / 30, 8), code, "at {seconds}s");
        }
    }

    #[test]
    fn a_code_counts_within_one_step_and_only_once() {
        let secret = b"12345678901234567890";
        let now = 1_000_000;
        let code = |step| format!("{:06}", code_at(secret, step, DIGITS));
        assert_eq!(matching_step(secret, &code(now), now, None), Some(now));
        assert_eq!(
            matching_step(secret, &code(now - 1), now, None),
            Some(now - 1)
        );
        assert_eq!(
            matching_step(secret, &code(now + 1), now, None),
            Some(now + 1)
        );
        assert_eq!(matching_step(secret, &code(now - 2), now, None), None);
        // At or before the last accepted step is a replay.
        assert_eq!(matching_step(secret, &code(now), now, Some(now)), None);
        assert_eq!(
            matching_step(secret, &code(now - 1), now, Some(now - 1)),
            None
        );
        assert_eq!(matching_step(secret, "12345", now, None), None);
        assert_eq!(matching_step(secret, "abcdef", now, None), None);
    }

    #[test]
    fn base32_matches_rfc_4648() {
        assert_eq!(base32(b""), "");
        assert_eq!(base32(b"f"), "MY");
        assert_eq!(base32(b"foobar"), "MZXW6YTBOI");
        assert_eq!(
            base32(b"12345678901234567890"),
            "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
        );
    }

    #[test]
    fn the_uri_names_the_parameters_apps_need() {
        let uri = otpauth_uri("ABC");
        assert!(uri.starts_with("otpauth://totp/Yarvis:"), "{uri}");
        for part in [
            "secret=ABC",
            "issuer=Yarvis",
            "digits=6",
            "period=30",
            "algorithm=SHA1",
        ] {
            assert!(uri.contains(part), "{uri}");
        }
        assert!(qr_svg(&uri).starts_with("<?xml"));
    }
}
