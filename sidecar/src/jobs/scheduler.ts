import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import { redactSecrets } from "../llm/errors.ts";
import { isDue, type JobSchedule } from "./schedule.ts";
import { claimJob, DEFAULT_LEASE_MS, finishJob, getJobRun, listJobRuns } from "./store.ts";

/**
 * The sidecar's background job runner.
 *
 * One timer ticks over the registered jobs, claims the ones whose schedule is
 * due, and runs them. Everything a job needs beyond its own logic — the lease
 * that keeps two processes from doing the same work, the recorded outcome, the
 * cursor it left behind — lives here, so a job is a schedule plus a function.
 *
 * Like the workspace poller, this is started from `server.ts` only when the
 * instance owns background work.
 */

export interface JobContext {
  db: Db;
  config: Config;
  /** Whatever the job's previous run stored, or null on a first run. */
  cursor: unknown;
  /** The run's reference instant; injected so a job's window is testable. */
  now: Date;
}

export interface JobResult {
  /** Human-readable outcome, logged and surfaced in the jobs UI. */
  detail?: string;
  /** Persisted for the next run to read from `JobContext.cursor`. */
  cursor?: unknown;
  /** True when the job found nothing to do; recorded as "skipped". */
  skipped?: boolean;
}

export interface JobDefinition {
  name: string;
  /** Shown in the jobs UI; explains what running it would do. */
  description: string;
  schedule: JobSchedule;
  run: (ctx: JobContext) => Promise<JobResult>;
  /** Overrides the default lease for a job that legitimately runs long. */
  leaseMs?: number;
}

/** How often the runner checks whether anything is due. */
const TICK_MS = 60_000;

/**
 * Runs one job right now, bypassing its schedule but not its lease — the manual
 * trigger in the jobs UI uses this, and it must not be able to start a second
 * copy of a job that is already running.
 *
 * Returns what happened, including the "already running" case, so the caller can
 * report it rather than having to infer it from silence.
 */
export async function runJob(
  job: JobDefinition,
  config: Config,
  db: Db,
  now: Date = new Date(),
): Promise<{ ran: boolean; status: "ok" | "error" | "skipped" | "busy"; detail?: string }> {
  const claimed = await claimJob(db, job.name, job.leaseMs ?? DEFAULT_LEASE_MS);
  if (!claimed) return { ran: false, status: "busy", detail: "already running" };

  try {
    const result = await job.run({ db, config, cursor: claimed.cursor, now });
    const status = result.skipped ? "skipped" : "ok";
    await finishJob(db, job.name, { status, cursor: result.cursor });
    if (result.detail) console.log(`[jobs] ${job.name}: ${result.detail}`);
    return { ran: true, status, detail: result.detail };
  } catch (e) {
    // Jobs reach out to providers and read the filesystem; a message can carry a
    // connection string or an API key, and it is stored and shown in the UI.
    const message = redactSecrets(e instanceof Error ? e.message : String(e));
    console.error(`[jobs] ${job.name} failed:`, message);
    await finishJob(db, job.name, { status: "error", error: message }).catch(() => {});
    return { ran: true, status: "error", detail: message };
  }
}

/** Claims and runs whatever is due. Exported for tests, which drive it directly
 *  rather than waiting on the timer. */
export async function tick(
  jobs: JobDefinition[],
  config: Config,
  db: Db,
  now: Date = new Date(),
): Promise<void> {
  for (const job of jobs) {
    // Read before claiming: the claim itself writes `lastStartedAt`, so asking
    // afterwards would always look due.
    const run = await getJobRun(db, job.name).catch(() => null);
    if (!isDue(job.schedule, run, now)) continue;
    await runJob(job, config, db, now);
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

/**
 * Starts the tick loop. A no-op without a database, mirroring the other
 * background workers. Jobs run sequentially within a tick: they share an LLM
 * budget and a database, and none of them is latency-sensitive.
 */
export function startJobScheduler(
  config: Config,
  jobs: JobDefinition[],
  tickMs: number = TICK_MS,
): SchedulerHandle {
  if (!config.databaseUrl) {
    console.log("[jobs] no database configured; scheduler not started");
    return { stop: () => undefined };
  }
  const db = getDb(config.databaseUrl).db;
  let running = false;

  const runTick = async () => {
    // A tick that overruns the interval must not start a second sweep; the lease
    // would stop double-running a job, but the log would fill with contention.
    if (running) return;
    running = true;
    try {
      await tick(jobs, config, db);
    } catch (e) {
      console.error("[jobs] tick failed:", redactSecrets(String(e)));
    } finally {
      running = false;
    }
  };

  const timer = setInterval(runTick, tickMs);
  // Don't hold the process open for a job — the sidecar exits when its parent
  // does, and a pending tick is not worth delaying that.
  timer.unref?.();
  // First sweep immediately, so a restart picks up work that came due while the
  // app was closed rather than waiting out a tick.
  void runTick();

  console.log(`[jobs] scheduler started with ${jobs.length} job(s)`);
  return { stop: () => clearInterval(timer) };
}

export interface JobStatus {
  name: string;
  description: string;
  schedule: JobSchedule;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  running: boolean;
  due: boolean;
}

/** The jobs plus their stored state, for the settings UI. */
export async function jobStatuses(
  jobs: JobDefinition[],
  db: Db,
  now: Date = new Date(),
): Promise<JobStatus[]> {
  const runs = new Map((await listJobRuns(db)).map((r) => [r.name, r]));
  return jobs.map((job) => {
    const run = runs.get(job.name) ?? null;
    return {
      name: job.name,
      description: job.description,
      schedule: job.schedule,
      lastStartedAt: run?.lastStartedAt ?? null,
      lastFinishedAt: run?.lastFinishedAt ?? null,
      lastStatus: run?.lastStatus ?? null,
      lastError: run?.lastError ?? null,
      running: Boolean(run?.leaseUntil && run.leaseUntil > now),
      due: isDue(job.schedule, run, now),
    };
  });
}
