import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type JobRun, jobRuns } from "../db/schema.ts";

/**
 * Lease bookkeeping for the background jobs. Several app instances can share one
 * database (see `instance.rs`), and background workers are already limited to
 * one of them — but a restart, a second dev instance pointed at the same
 * database, or a job that outlives its tick would still double-run without a
 * claim. The claim is a single conditional statement, so two processes racing it
 * cannot both win.
 */

/** How long a claim is held before it is considered abandoned. */
export const DEFAULT_LEASE_MS = 15 * 60 * 1000;

/** The stored state for one job, or null if it has never been seen. */
export async function getJobRun(db: Db, name: string): Promise<JobRun | null> {
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.name, name));
  return row ?? null;
}

export async function listJobRuns(db: Db): Promise<JobRun[]> {
  return db.select().from(jobRuns);
}

/**
 * Takes the lease for a job, returning the row when this process won it and null
 * when someone else holds a live one. The insert-on-conflict form does both the
 * first claim and every later one, so there is no separate "register the job"
 * step that could be skipped.
 */
export async function claimJob(
  db: Db,
  name: string,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<JobRun | null> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const [row] = await db
    .insert(jobRuns)
    .values({ name, lastStartedAt: now, leaseUntil, updatedAt: now })
    .onConflictDoUpdate({
      target: jobRuns.name,
      set: { lastStartedAt: now, leaseUntil, updatedAt: now },
      // Only when nobody holds the lease, or the holder's has expired — which is
      // what makes a crashed run recoverable without an operator.
      setWhere: or(isNull(jobRuns.leaseUntil), lt(jobRuns.leaseUntil, now)),
    })
    .returning();
  return row ?? null;
}

export interface FinishJobInput {
  status: "ok" | "error" | "skipped";
  error?: string | null;
  /** Replaces the stored cursor when provided; left alone otherwise. */
  cursor?: unknown;
}

/** Releases the lease and records the outcome. */
export async function finishJob(db: Db, name: string, input: FinishJobInput): Promise<void> {
  const now = new Date();
  await db
    .update(jobRuns)
    .set({
      lastFinishedAt: now,
      lastStatus: input.status,
      lastError: input.error ?? null,
      leaseUntil: null,
      updatedAt: now,
      ...(input.cursor !== undefined ? { cursor: input.cursor as JobRun["cursor"] } : {}),
    })
    .where(eq(jobRuns.name, name));
}

/**
 * Clears a lease without recording an outcome. For the tick that claimed a job
 * and then found nothing to do — the claim itself already moved
 * `lastStartedAt`, which is what the schedule reads.
 */
export async function releaseJob(db: Db, name: string): Promise<void> {
  await db
    .update(jobRuns)
    .set({ leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(jobRuns.name, name), sql`true`));
}
