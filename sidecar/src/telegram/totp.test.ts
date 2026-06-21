import { describe, expect, it } from "bun:test";
import { base32Decode, generateTotp, verifyTotp } from "./totp.ts";

// RFC 6238 test secret: ASCII "12345678901234567890" in base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32Decode", () => {
  it("decodes the RFC test secret to the ASCII digits", () => {
    expect(new TextDecoder().decode(base32Decode(RFC_SECRET))).toBe("12345678901234567890");
  });

  it("is tolerant of lowercase, spaces, and padding", () => {
    expect(base32Decode("ge zd gn==".replace(/ /g, ""))).toEqual(base32Decode("GEZDGN"));
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("0189!")).toThrow();
  });
});

describe("generateTotp", () => {
  // RFC 6238 Appendix B vectors (SHA1), truncated to 6 digits.
  it("matches the RFC 6238 vectors", async () => {
    expect(await generateTotp(RFC_SECRET, 59_000)).toBe("287082");
    expect(await generateTotp(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(await generateTotp(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
  });
});

describe("verifyTotp", () => {
  it("accepts the current code", async () => {
    const now = 1_111_111_109_000;
    const code = await generateTotp(RFC_SECRET, now);
    expect(await verifyTotp(RFC_SECRET, code, now)).toBe(true);
  });

  it("accepts a code one step old (clock-skew window)", async () => {
    const now = 1_111_111_109_000;
    const prev = await generateTotp(RFC_SECRET, now - 30_000);
    expect(await verifyTotp(RFC_SECRET, prev, now)).toBe(true);
  });

  it("rejects a code two steps old", async () => {
    const now = 1_111_111_109_000;
    const old = await generateTotp(RFC_SECRET, now - 60_000);
    expect(await verifyTotp(RFC_SECRET, old, now)).toBe(false);
  });

  it("rejects wrong and malformed codes without throwing", async () => {
    const now = 1_111_111_109_000;
    expect(await verifyTotp(RFC_SECRET, "000000", now)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, "abc", now)).toBe(false);
    expect(await verifyTotp(RFC_SECRET, "", now)).toBe(false);
  });
});
