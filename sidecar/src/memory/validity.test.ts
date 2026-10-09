import { describe, expect, it } from "bun:test";
import { parseDuration, resolveValidity } from "./validity.ts";

const HOUR = 60 * 60_000;
const now = new Date("2026-10-08T10:00:00Z");

describe("memory validity input", () => {
  it("parses weeks, days, hours and minutes", () => {
    expect(parseDuration("PT1H")).toBe(HOUR);
    expect(parseDuration("PT30M")).toBe(HOUR / 2);
    expect(parseDuration("P1DT12H")).toBe(36 * HOUR);
    expect(parseDuration("P2W")).toBe(14 * 24 * HOUR);
  });

  it("rejects empty, zero and calendar durations", () => {
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("PT0H")).toBeNull();
    expect(parseDuration("P1M")).toBeNull();
    expect(parseDuration("1 hour")).toBeNull();
  });

  it("measures validFor from now", () => {
    expect(resolveValidity({ validFor: "PT1H" }, now)).toEqual({
      ok: true,
      validFrom: undefined,
      validUntil: new Date(now.getTime() + HOUR),
    });
  });

  it("measures validFor from validFrom when the claim starts later", () => {
    const result = resolveValidity({ validFrom: "2026-10-20T00:00:00Z", validFor: "P1W" }, now);
    expect(result).toEqual({
      ok: true,
      validFrom: new Date("2026-10-20T00:00:00Z"),
      validUntil: new Date("2026-10-27T00:00:00Z"),
    });
  });

  it("refuses validFor and validUntil together", () => {
    const result = resolveValidity({ validFor: "PT1H", validUntil: "2026-10-09T00:00:00Z" }, now);
    expect(result.ok).toBe(false);
  });

  it("refuses a validUntil that isn't after the start", () => {
    expect(resolveValidity({ validUntil: "2026-10-08T09:00:00Z" }, now).ok).toBe(false);
  });

  it("leaves both bounds unset when nothing is asked for", () => {
    expect(resolveValidity({}, now)).toEqual({
      ok: true,
      validFrom: undefined,
      validUntil: undefined,
    });
  });
});
