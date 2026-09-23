import { Cron } from "croner";

/**
 * Cron expressions for the user-defined scheduled jobs.
 *
 * The jobs this repo ships as code use the `interval`/`daily` shapes in
 * `schedule.ts`, which are enough for work whose timing nobody has an opinion
 * about. A job a person writes is the opposite case — "weekdays at 08:45",
 * "the first of the month" — so those carry a cron expression instead.
 *
 * Evaluated in the machine's local time zone, like every other schedule here:
 * the user writes "08:45" meaning the clock in front of them, and croner's
 * default is the same local time, including across a DST shift.
 */

/** Guard against a pathological expression before it reaches the parser. */
const MAX_EXPRESSION_CHARS = 200;

export interface CronProblem {
  message: string;
}

/**
 * Compiles an expression, or returns why it won't compile. Callers validate on
 * write so a job can never be stored with a schedule the tick would throw on;
 * the tick validates again because the row could have been written by an older
 * build.
 */
export function parseCron(expression: string): { cron: Cron } | { problem: CronProblem } {
  const trimmed = expression.trim();
  if (!trimmed) return { problem: { message: "cron expression is empty" } };
  if (trimmed.length > MAX_EXPRESSION_CHARS) {
    return { problem: { message: `cron expression is longer than ${MAX_EXPRESSION_CHARS} chars` } };
  }
  try {
    // `paused` so constructing one never schedules a timer: this is a calendar
    // calculation, and the firing is the job scheduler's business.
    return { cron: new Cron(trimmed, { paused: true }) };
  } catch (e) {
    return { problem: { message: e instanceof Error ? e.message : String(e) } };
  }
}

export function isValidCron(expression: string): boolean {
  return "cron" in parseCron(expression);
}

/**
 * The next time an expression fires after `from`, or null when it never will
 * again (a one-off date that has passed) or the expression is invalid.
 */
export function nextCronRun(expression: string, from: Date = new Date()): Date | null {
  const parsed = parseCron(expression);
  if ("problem" in parsed) return null;
  return parsed.cron.nextRun(from) ?? null;
}

/**
 * Whether a cron job should start now.
 *
 * Asked as "was there a firing between the last start and now", not "does the
 * current minute match", so a machine that was asleep at 08:45 still runs the
 * job when it wakes rather than skipping the day. The tick is once a minute and
 * the comparison is against the *last start*, so a job fires at most once per
 * firing time.
 *
 * A job that has never run waits for its next scheduled time instead of firing
 * immediately — unlike the built-in jobs, whose first run backfills. A user job
 * runs a prompt with side effects the user timed deliberately; "saved at 17:00"
 * is not a reason to run the 08:45 job.
 */
export function isCronDue(expression: string, lastStartedAt: Date | null, now: Date): boolean {
  const parsed = parseCron(expression);
  if ("problem" in parsed) return false;
  const since = lastStartedAt ?? now;
  const next = parsed.cron.nextRun(since);
  return next !== null && next <= now;
}
