import type { JobRun } from "../db/schema.ts";

/**
 * When a background job wants to run. Two shapes, because the jobs here divide
 * cleanly: an interval suits work whose value is freshness (consolidate the last
 * few hours of events), while a daily anchor suits work that summarizes a
 * finished day and would produce a half-day summary if it fired at any hour.
 */
export type JobSchedule =
  | { kind: "interval"; everyMs: number }
  | {
      kind: "daily";
      /** Local hour (0–23) the job becomes eligible on each new day. */
      hour: number;
    };

/** Convenience for the common interval shape. */
export const everyHours = (hours: number): JobSchedule => ({
  kind: "interval",
  everyMs: hours * 60 * 60 * 1000,
});

/** Convenience for the daily shape, e.g. `dailyAt(3)` for the small hours. */
export const dailyAt = (hour: number): JobSchedule => ({ kind: "daily", hour });

/** The local calendar day an instant falls on, as `YYYY-MM-DD`. */
function localDay(at: Date): string {
  const year = at.getFullYear();
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Whether a job should start now. A job that has never run is always due, so a
 * fresh install summarizes what it already has rather than waiting a full
 * interval.
 *
 * A daily job is due once the local hour has been reached on a day it hasn't run
 * on yet. Comparing *days* rather than elapsed milliseconds is what makes it
 * survive a machine that was asleep at the anchor hour: the job fires late on
 * the same day instead of being skipped, and still only once.
 *
 * Pure, and `now` is injected, so the timing rules are unit-testable without a
 * clock or a database.
 */
export function isDue(
  schedule: JobSchedule,
  run: Pick<JobRun, "lastStartedAt"> | null | undefined,
  now: Date = new Date(),
): boolean {
  const last = run?.lastStartedAt ?? null;
  if (!last) return true;
  if (schedule.kind === "interval") {
    return now.getTime() - last.getTime() >= schedule.everyMs;
  }
  if (now.getHours() < schedule.hour) return false;
  return localDay(last) !== localDay(now);
}
