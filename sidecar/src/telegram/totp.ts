/**
 * Minimal RFC 6238 TOTP verification (HMAC-SHA1, the algorithm every
 * authenticator app defaults to). Implemented directly on Web Crypto rather than
 * pulling a dependency: the surface is small, security-sensitive, and easy to
 * pin to the RFC's published test vectors (see totp.test.ts).
 *
 * The secret is a base32 string (what authenticator apps expect); only decoding
 * and verification live here — the secret is generated in the app at enrollment.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Decodes an RFC 4648 base32 string (case-insensitive, padding/space tolerant). */
export function base32Decode(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

async function hmacSha1(
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message);
  return new Uint8Array(sig);
}

/** Encodes a counter as an 8-byte big-endian buffer (counters stay < 2^53). */
function counterBytes(counter: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff;
    c = Math.floor(c / 256);
  }
  return buf;
}

/** Computes the TOTP code for a base32 secret at the given epoch-millis time. */
export async function generateTotp(
  secret: string,
  timeMs: number,
  period = 30,
  digits = 6,
): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / period);
  const hash = await hmacSha1(base32Decode(secret), counterBytes(counter));
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = hash[hash.length - 1]! & 0x0f;
  const bin =
    ((hash[offset]! & 0x7f) << 24) |
    (hash[offset + 1]! << 16) |
    (hash[offset + 2]! << 8) |
    hash[offset + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, "0");
}

/** Constant-time string compare for equal-length codes. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verifies a submitted code against the secret, accepting codes within ±`window`
 * steps to tolerate clock skew between the app and the authenticator. Rejects
 * non-numeric input before doing any crypto.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  timeMs: number,
  opts: { window?: number; period?: number; digits?: number } = {},
): Promise<boolean> {
  const window = opts.window ?? 1;
  const period = opts.period ?? 30;
  const digits = opts.digits ?? 6;
  const cleaned = code.trim();
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return false;
  for (let i = -window; i <= window; i++) {
    const expected = await generateTotp(secret, timeMs + i * period * 1000, period, digits);
    if (timingSafeEqual(expected, cleaned)) return true;
  }
  return false;
}
