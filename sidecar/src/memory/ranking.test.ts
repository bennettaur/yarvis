import { describe, expect, it } from "bun:test";
import {
  EXPIRED_FACTOR,
  HALF_LIFE_DAYS,
  STRENGTH_FLOOR,
  scoreMemory,
  strengthAt,
} from "./ranking.ts";

const DAY = 24 * 60 * 60_000;
const now = new Date("2026-10-08T00:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

describe("memory ranking", () => {
  it("is at full strength when just confirmed", () => {
    expect(strengthAt("fact", now, 0, now)).toBe(1);
  });

  it("falls halfway to the floor after one half-life", () => {
    const strength = strengthAt("fact", daysAgo(HALF_LIFE_DAYS.fact), 0, now);
    expect(strength).toBeCloseTo(STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) / 2, 6);
  });

  it("never falls below the floor", () => {
    expect(strengthAt("activity-summary", daysAgo(10_000), 0, now)).toBeCloseTo(STRENGTH_FLOOR, 6);
  });

  it("fades slower for each confirmation", () => {
    const once = strengthAt("fact", daysAgo(90), 0, now);
    const thrice = strengthAt("fact", daysAgo(90), 2, now);
    expect(thrice).toBeGreaterThan(once);
  });

  it("fades summaries faster than preferences", () => {
    expect(strengthAt("activity-summary", daysAgo(30), 0, now)).toBeLessThan(
      strengthAt("preference", daysAgo(30), 0, now),
    );
  });

  it("scales an expired memory's score down", () => {
    const base = { kind: "fact" as const, similarity: 0.8, confirmedAt: now, confirmCount: 0 };
    const current = scoreMemory({ ...base, validFrom: daysAgo(1), validUntil: null }, now);
    const expired = scoreMemory({ ...base, validFrom: daysAgo(1), validUntil: daysAgo(0.5) }, now);
    expect(current.score).toBeCloseTo(0.8, 6);
    expect(expired.score).toBeCloseTo(0.8 * EXPIRED_FACTOR, 6);
  });

  it("judges validity at the instant asked about but decay from now", () => {
    const score = scoreMemory(
      {
        kind: "fact",
        similarity: 1,
        validFrom: daysAgo(10),
        validUntil: daysAgo(5),
        confirmedAt: daysAgo(HALF_LIFE_DAYS.fact),
        confirmCount: 0,
      },
      now,
      daysAgo(7),
    );
    // Held seven days ago, so no expiry penalty; confirmed a half-life ago, so
    // strength is halfway to the floor.
    const halfway = STRENGTH_FLOOR + (1 - STRENGTH_FLOOR) / 2;
    expect(score.strength).toBeCloseTo(halfway, 6);
    expect(score.score).toBeCloseTo(halfway, 6);
  });
});
