import { describe, expect, it } from "bun:test";
import { dailyAt, everyHours, isDue } from "./schedule.ts";

const at = (iso: string) => new Date(iso);
const ran = (iso: string) => ({ lastStartedAt: at(iso) });

describe("job schedules", () => {
  it("treats a job that has never run as due", () => {
    expect(isDue(everyHours(4), null, at("2026-08-24T09:00:00"))).toBe(true);
    expect(isDue(dailyAt(3), undefined, at("2026-08-24T01:00:00"))).toBe(true);
  });

  it("holds an interval job until the interval has elapsed", () => {
    const schedule = everyHours(4);
    expect(isDue(schedule, ran("2026-08-24T06:00:00"), at("2026-08-24T09:59:00"))).toBe(false);
    expect(isDue(schedule, ran("2026-08-24T06:00:00"), at("2026-08-24T10:00:00"))).toBe(true);
  });

  it("holds a daily job until its anchor hour", () => {
    const schedule = dailyAt(3);
    expect(isDue(schedule, ran("2026-08-23T03:10:00"), at("2026-08-24T02:59:00"))).toBe(false);
    expect(isDue(schedule, ran("2026-08-23T03:10:00"), at("2026-08-24T03:00:00"))).toBe(true);
  });

  it("runs a daily job once per day even when it fires late", () => {
    const schedule = dailyAt(3);
    // Machine asleep at 03:00; the job is still due when it wakes at noon.
    expect(isDue(schedule, ran("2026-08-23T03:00:00"), at("2026-08-24T12:00:00"))).toBe(true);
    // And not again later the same day.
    expect(isDue(schedule, ran("2026-08-24T12:00:00"), at("2026-08-24T23:00:00"))).toBe(false);
  });
});
