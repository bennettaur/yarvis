import { createHmac } from "node:crypto";

/**
 * RFC 6238 codes, as an authenticator app computes them, so the end-to-end
 * test can sign in with the secret setup returned.
 */

/** RFC 4648 base32, as setup returns the secret. */
export function base32Decode(text: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const c of text.replace(/=+$/, "")) {
    const value = alphabet.indexOf(c);
    if (value < 0) throw new Error(`not base32: ${c}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** The HOTP code for one 30-second step (RFC 4226 with the step as the counter). */
export function codeAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac("sha1", secret).update(counter).digest();
  const offset = (hash[hash.length - 1] ?? 0) & 0x0f;
  const truncated = hash.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

export const stepNow = () => Math.floor(Date.now() / 30_000);

/**
 * Hands out codes the server will accept: each step only once, as the server
 * allows, and never more than one step ahead of now.
 */
export class Authenticator {
  private lastStep = -1;
  constructor(private readonly secret: Buffer) {}

  async code(): Promise<string> {
    for (;;) {
      const now = stepNow();
      const step = Math.max(now, this.lastStep + 1);
      if (step <= now + 1) {
        this.lastStep = step;
        return codeAt(this.secret, step);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** A code that is certainly wrong right now. */
  wrongCode(): string {
    const now = stepNow();
    const taken = new Set([-1, 0, 1].map((d) => codeAt(this.secret, now + d)));
    for (let n = 0; ; n++) {
      const guess = String(n).padStart(6, "0");
      if (!taken.has(guess)) return guess;
    }
  }
}
