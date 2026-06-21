import { describe, expect, it } from "bun:test";
import { formatSecretForDisplay, generateOtpSecret, otpauthUri } from "./otp";

describe("generateOtpSecret", () => {
  it("produces a base32 string of the requested length", () => {
    const secret = generateOtpSecret();
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
  });

  it("is random across calls", () => {
    expect(generateOtpSecret()).not.toBe(generateOtpSecret());
  });
});

describe("otpauthUri", () => {
  it("builds a TOTP URI with the secret and standard parameters", () => {
    const uri = otpauthUri("ABC234", "Telegram");
    expect(uri).toContain("otpauth://totp/Yarvis%3ATelegram?");
    expect(uri).toContain("secret=ABC234");
    expect(uri).toContain("issuer=Yarvis");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("formatSecretForDisplay", () => {
  it("groups the secret into blocks of four", () => {
    expect(formatSecretForDisplay("ABCDEFGH")).toBe("ABCD EFGH");
    expect(formatSecretForDisplay("ABCDEF")).toBe("ABCD EF");
  });
});
