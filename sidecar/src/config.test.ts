import { describe, expect, it } from "bun:test";
import { parseAllowedChatIds, parseOtpWindowMinutes } from "./config.ts";

describe("parseAllowedChatIds", () => {
  it("parses a comma-separated list, dropping malformed entries", () => {
    expect(parseAllowedChatIds("42, 7 ,abc, 9")).toEqual([42, 7, 9]);
  });

  it("returns an empty list for undefined or empty input", () => {
    expect(parseAllowedChatIds(undefined)).toEqual([]);
    expect(parseAllowedChatIds("   ")).toEqual([]);
  });

  it("accepts negative ids (groups) but drops non-integers", () => {
    expect(parseAllowedChatIds("-100123, 4.5, 8")).toEqual([-100123, 8]);
  });
});

describe("parseOtpWindowMinutes", () => {
  it("defaults to 120 for missing, zero, negative, or non-numeric input", () => {
    expect(parseOtpWindowMinutes(undefined)).toBe(120);
    expect(parseOtpWindowMinutes("0")).toBe(120);
    expect(parseOtpWindowMinutes("-5")).toBe(120);
    expect(parseOtpWindowMinutes("abc")).toBe(120);
  });

  it("floors a valid value", () => {
    expect(parseOtpWindowMinutes("90")).toBe(90);
    expect(parseOtpWindowMinutes("45.9")).toBe(45);
  });

  it("clamps absurdly large values to one week", () => {
    expect(parseOtpWindowMinutes("999999")).toBe(7 * 24 * 60);
  });
});
