/**
 * Client-side helpers for enrolling a TOTP second factor. The secret is
 * generated here (so it can be shown for enrollment) and stored in the Keychain;
 * the sidecar verifies submitted codes against it. Verification never happens in
 * the frontend.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Generates a base32 TOTP secret. 256 is a multiple of 32, so mapping each
 * random byte with `% 32` is unbiased. 32 chars ≈ 160 bits, the RFC-recommended
 * SHA1 key size.
 */
export function generateOtpSecret(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => BASE32_ALPHABET[b % 32]).join("");
}

/** Builds the otpauth:// URI authenticator apps import (manual entry also works). */
export function otpauthUri(secret: string, account: string, issuer = "Yarvis"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Formats a secret in groups of 4 for easier manual entry into an authenticator. */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}
