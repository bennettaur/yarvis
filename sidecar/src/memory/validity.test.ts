import { describe, expect, it } from "bun:test";
import { parseDuration, resolveValidityWindow, validityAt } from "./validity.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const now = new Date("2026-10-08T10:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("memory validity input", () => {
  it("parses weeks, days, hours and minutes", () => {
    expect(parseDuration("PT1H")).toBe(HOUR);
    expect(parseDuration("PT30M")).toBe(HOUR / 2);
    expect(parseDuration("P1DT12H")).toBe(36 * HOUR);
    expect(parseDuration("P2W")).toBe(14 * 24 * HOUR);
  });

  it("tells current, upcoming and expired apart", () => {
    expect(validityAt(daysAgo(1), null, now)).toBe("current");
    expect(validityAt(daysAgo(-1), null, now)).toBe("upcoming");
    expect(validityAt(daysAgo(2), daysAgo(1), now)).toBe("expired");
    // The end is exclusive: a window that closes now has closed.
    expect(validityAt(daysAgo(1), now, now)).toBe("expired");
  });

  it("rejects durations past ten years, which would overflow a date", () => {
    expect(parseDuration("P9999999999W")).toBeNull();
    expect(parseDuration("P99999999999999999999D")).toBeNull();
    expect(resolveValidityWindow({ validFor: "P9999999999W" }, now).ok).toBe(false);
  });

  it("rejects a validUntil more than ten years out", () => {
    expect(resolveValidityWindow({ validUntil: "9999-12-31T00:00:00Z" }, now).ok).toBe(false);
  });

  it("measures from a later start when one is given", () => {
    const start = new Date("2026-10-20T00:00:00Z");
    expect(resolveValidityWindow({ validFor: "P1D" }, start)).toEqual({
      ok: true,
      validFrom: undefined,
      validUntil: new Date("2026-10-21T00:00:00Z"),
    });
  });

  it("rejects empty, zero and calendar durations", () => {
    expect(parseDuration("P")).toBeNull();
    expect(parseDuration("PT")).toBeNull();
    expect(parseDuration("PT0H")).toBeNull();
    expect(parseDuration("P1M")).toBeNull();
    expect(parseDuration("1 hour")).toBeNull();
  });

  it("measures validFor from now", () => {
    expect(resolveValidityWindow({ validFor: "PT1H" }, now)).toEqual({
      ok: true,
      validFrom: undefined,
      validUntil: new Date(now.getTime() + HOUR),
    });
  });

  it("measures validFor from validFrom when the claim starts later", () => {
    const result = resolveValidityWindow(
      { validFrom: "2026-10-20T00:00:00Z", validFor: "P1W" },
      now,
    );
    expect(result).toEqual({
      ok: true,
      validFrom: new Date("2026-10-20T00:00:00Z"),
      validUntil: new Date("2026-10-27T00:00:00Z"),
    });
  });

  it("refuses validFor and validUntil together", () => {
    const result = resolveValidityWindow(
      { validFor: "PT1H", validUntil: "2026-10-09T00:00:00Z" },
      now,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a validUntil that isn't after the start", () => {
    expect(resolveValidityWindow({ validUntil: "2026-10-08T09:00:00Z" }, now).ok).toBe(false);
  });

  it("leaves both bounds unset when nothing is asked for", () => {
    expect(resolveValidityWindow({}, now)).toEqual({
      ok: true,
      validFrom: undefined,
      validUntil: undefined,
    });
  });
});
