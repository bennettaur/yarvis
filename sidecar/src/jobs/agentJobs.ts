import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  jobRuns,
  type NewScheduledJob,
  type ScheduledJob,
  type ScheduledJobRun,
  scheduledJobRuns,
  scheduledJobs,
} from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";
import { isValidCron, nextCronRun } from "./cron.ts";
import { type AgentJobRunner, defaultRunners, type RunnerSet } from "./runners.ts";
import type { JobContext, JobDefinition, JobResult, JobTrigger } from "./scheduler.ts";

/**
 * User-defined scheduled jobs: a cron schedule, a prompt, and the agent that
 * runs it.
 *
 * The jobs this repo ships as code are a schedule plus a function
 * (`scheduler.ts`). These are the same thing assembled from a row — which is
 * what lets the scheduler treat both alike: `toJobDefinition` turns a row into
 * the definition a tick already knows how to lease and run. The synthetic name
 * `agent-job:<id>` is what ties a row to its lease in `job_runs`; it is derived
 * from the id rather than the user's title so renaming a job doesn't orphan its
 * lease.
 */

/** Prefix of the scheduler name a stored job runs under. */
export const AGENT_JOB_PREFIX = "agent-job:";

export const jobSchedulerName = (id: string): string => `${AGENT_JOB_PREFIX}${id}`;

/** The job id inside a scheduler name, or null when the name isn't one of ours. */
export function jobIdFromSchedulerName(name: string): string | null {
  return name.startsWith(AGENT_JOB_PREFIX) ? name.slice(AGENT_JOB_PREFIX.length) : null;
}

/** Permission modes `claude --permission-mode` accepts. */
export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/**
 * Which agent runs a job, and what that agent needs to know.
 *
 * Stored as the row's `agentConfig`, discriminated by `agentKind`. A yarvis job
 * with no specialist runs against the default agent; a Claude Code job always
 * needs a directory, because a headless run's whole context is where it starts.
 */
export type AgentJobTarget =
  | { kind: "yarvis"; specialist: string | null }
  | {
      kind: "claude-code";
      cwd: string;
      model: string | null;
      permissionMode: ClaudePermissionMode | null;
    };

/**
 * Specialist name given to a row whose `agentKind` is not one this build knows.
 * No specialist can be called this (`findSpecialist` reads file names), so the
 * run fails with a readable error instead of falling through to a backend the
 * row never asked for.
 */
export const UNREADABLE_TARGET = "\u0000unreadable";

/** A stored job with its config read back as a target. */
export interface AgentJob extends Omit<ScheduledJob, "agentKind" | "agentConfig"> {
  target: AgentJobTarget;
}

export interface AgentJobInput {
  name: string;
  description: string | null;
  cron: string;
  prompt: string;
  enabled: boolean;
  target: AgentJobTarget;
}

/**
 * Reads a row's stored config back into a target.
 *
 * Tolerant by design: the column is jsonb, and a row written by an older build
 * (or edited by hand) must still list and still be deletable rather than
 * breaking the whole panel. A shape that can't be understood reads as a yarvis
 * job with an empty specialist name, which `runYarvisJob` refuses to run — a row
 * nobody can interpret is listed and deletable but never executed, rather than
 * silently running against the default agent's whole tool surface.
 */
export function readTarget(kind: string, config: Record<string, unknown>): AgentJobTarget {
  if (kind === "claude-code") {
    const mode = config.permissionMode;
    return {
      kind: "claude-code",
      cwd: typeof config.cwd === "string" ? config.cwd : "",
      model: typeof config.model === "string" && config.model ? config.model : null,
      permissionMode: CLAUDE_PERMISSION_MODES.includes(mode as ClaudePermissionMode)
        ? (mode as ClaudePermissionMode)
        : null,
    };
  }
  if (kind !== "yarvis") return { kind: "yarvis", specialist: UNREADABLE_TARGET };
  const specialist = config.specialist;
  return {
    kind: "yarvis",
    specialist: typeof specialist === "string" && specialist ? specialist : null,
  };
}

function toAgentJob(row: ScheduledJob): AgentJob {
  const { agentKind, agentConfig, ...rest } = row;
  return { ...rest, target: readTarget(agentKind, agentConfig) };
}

function toRow(input: AgentJobInput): Omit<NewScheduledJob, "id"> {
  const { kind, ...config } = input.target;
  return {
    name: input.name,
    description: input.description,
    cron: input.cron,
    prompt: input.prompt,
    enabled: input.enabled,
    agentKind: kind,
    agentConfig: config as Record<string, unknown>,
  };
}

export async function listAgentJobs(db: Db): Promise<AgentJob[]> {
  const rows = await db.select().from(scheduledJobs).orderBy(scheduledJobs.name);
  return rows.map(toAgentJob);
}

export async function getAgentJob(db: Db, id: string): Promise<AgentJob | null> {
  const [row] = await db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id));
  return row ? toAgentJob(row) : null;
}

export async function createAgentJob(db: Db, input: AgentJobInput): Promise<AgentJob> {
  const [row] = await db.insert(scheduledJobs).values(toRow(input)).returning();
  return toAgentJob(row);
}

/**
 * Saves an edit, and re-anchors the schedule when the edit changes what "due"
 * means.
 *
 * `isCronDue` asks whether a firing fell between the last start and now, so a
 * job paused for a month — or one whose expression just changed — would be due
 * the instant it is saved, firing 08:45's prompt at 17:00. Stamping the lease's
 * `lastStartedAt` at the moment of the edit makes the next firing the first one
 * after it, which is the same rule a newly created job gets.
 */
export async function updateAgentJob(
  db: Db,
  id: string,
  input: AgentJobInput,
): Promise<AgentJob | null> {
  const before = await getAgentJob(db, id);
  const [row] = await db
    .update(scheduledJobs)
    .set({ ...toRow(input), updatedAt: new Date() })
    .where(eq(scheduledJobs.id, id))
    .returning();
  if (!row) return null;
  const resumed = before ? !before.enabled && input.enabled : false;
  const rescheduled = before ? before.cron !== input.cron : false;
  if (resumed || rescheduled) await anchorSchedule(db, id);
  return toAgentJob(row);
}

/** Moves a job's schedule anchor to now without recording a run. */
async function anchorSchedule(db: Db, id: string, now: Date = new Date()): Promise<void> {
  const name = jobSchedulerName(id);
  await db
    .insert(jobRuns)
    .values({ name, lastStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: jobRuns.name, set: { lastStartedAt: now, updatedAt: now } });
}

/**
 * Deletes a job, its history (by the runs table's cascade), and its lease row —
 * which has no foreign key to cascade through, so a delete that skipped it would
 * leave `job_runs` accumulating names that resolve to nothing.
 */
export async function deleteAgentJob(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(scheduledJobs).where(eq(scheduledJobs.id, id)).returning();
  if (rows.length === 0) return false;
  await db.delete(jobRuns).where(eq(jobRuns.name, jobSchedulerName(id)));
  return true;
}

/** Most recent runs first. */
export async function listAgentJobRuns(
  db: Db,
  jobId: string,
  limit = 50,
): Promise<ScheduledJobRun[]> {
  return db
    .select()
    .from(scheduledJobRuns)
    .where(eq(scheduledJobRuns.jobId, jobId))
    .orderBy(desc(scheduledJobRuns.startedAt))
    .limit(limit);
}

export async function getAgentJobRun(db: Db, runId: string): Promise<ScheduledJobRun | null> {
  const [row] = await db.select().from(scheduledJobRuns).where(eq(scheduledJobRuns.id, runId));
  return row ?? null;
}

/** Opens a run row so a job in flight is visible before it finishes. */
export async function startAgentJobRun(
  db: Db,
  jobId: string,
  trigger: JobTrigger,
  startedAt = new Date(),
): Promise<ScheduledJobRun> {
  const [row] = await db
    .insert(scheduledJobRuns)
    .values({ jobId, trigger, status: "running", startedAt })
    .returning();
  return row;
}

export interface FinishAgentJobRunInput {
  status: "ok" | "error";
  output?: string | null;
  error?: string | null;
}

export async function finishAgentJobRun(
  db: Db,
  runId: string,
  input: FinishAgentJobRunInput,
): Promise<void> {
  await db
    .update(scheduledJobRuns)
    .set({
      status: input.status,
      output: input.output ?? null,
      error: input.error ?? null,
      finishedAt: new Date(),
    })
    .where(eq(scheduledJobRuns.id, runId));
}

/**
 * Marks runs abandoned after the fact.
 *
 * A run row is opened before the agent starts and closed when it answers, so a
 * sidecar killed mid-run leaves a row reading "running" forever. Nothing will
 * ever close it, and the history would show a job that has been working for
 * three weeks — so a run still open well past the lease is recorded as an error
 * on the next sweep of that job.
 */
export async function failStaleRuns(db: Db, jobId: string, olderThan: Date): Promise<number> {
  const rows = await db
    .update(scheduledJobRuns)
    .set({
      status: "error",
      error: "the run did not finish — the app stopped before it reported back",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(scheduledJobRuns.jobId, jobId),
        eq(scheduledJobRuns.status, "running"),
        lt(scheduledJobRuns.startedAt, olderThan),
      ),
    )
    .returning();
  return rows.length;
}

/** Runs kept per job; older ones are dropped as new ones are recorded. */
export const MAX_RUNS_KEPT = 100;

/**
 * How long a run is kept regardless of the count. An answer can quote whatever
 * the agent read — file contents, a ticket, an inbox — so a weekly job should
 * not still be holding what it saw two years ago merely because it has run
 * fewer than {@link MAX_RUNS_KEPT} times.
 */
export const MAX_RUN_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Drops a job's oldest runs beyond {@link MAX_RUNS_KEPT}. */
export async function pruneAgentJobRuns(
  db: Db,
  jobId: string,
  keep = MAX_RUNS_KEPT,
  now: Date = new Date(),
): Promise<void> {
  await db
    .delete(scheduledJobRuns)
    .where(
      and(
        eq(scheduledJobRuns.jobId, jobId),
        lt(scheduledJobRuns.startedAt, new Date(now.getTime() - MAX_RUN_AGE_MS)),
      ),
    );
  await db.delete(scheduledJobRuns).where(
    and(
      eq(scheduledJobRuns.jobId, jobId),
      sql`${scheduledJobRuns.id} not in (
        select id from ${scheduledJobRuns}
        where ${scheduledJobRuns.jobId} = ${jobId}
        order by ${scheduledJobRuns.startedAt} desc
        limit ${keep}
      )`,
    ),
  );
}

/**
 * Ceiling on stored output. An agent asked to review a repository can answer
 * with a great deal of text, and this is read back into a panel and kept for a
 * hundred runs.
 */
export const MAX_STORED_OUTPUT_CHARS = 20_000;

/** Keeps both ends of an over-long answer: the opening and the conclusion. */
export function truncateOutput(text: string, max = MAX_STORED_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n…(truncated)…\n\n${text.slice(-half)}`;
}

/** How long an agent gets before its run is abandoned. */
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The lease an agent job holds. Longer than the run timeout so a run that is
 * still going never loses its lease to another tick — the timeout is what ends
 * a run, not the lease expiring underneath it.
 */
export const AGENT_JOB_LEASE_MS = RUN_TIMEOUT_MS + 5 * 60 * 1000;

export interface ToJobDefinitionOptions {
  runners?: RunnerSet;
  /** Overrides the run timeout; tests pass a short one. */
  timeoutMs?: number;
}

/**
 * Wraps a stored job as a scheduler job definition.
 *
 * Everything user-visible about a run — that it started, what the agent said,
 * why it failed — is written here rather than in the runner, so both backends
 * produce the same history. `job_runs` still records the latest outcome for the
 * lease; this adds the row the panel reads.
 */
export function toJobDefinition(
  job: AgentJob,
  options: ToJobDefinitionOptions = {},
): JobDefinition {
  const runners = options.runners ?? defaultRunners();
  const timeoutMs = options.timeoutMs ?? RUN_TIMEOUT_MS;
  return {
    name: jobSchedulerName(job.id),
    description: job.description ?? job.name,
    schedule: { kind: "cron", expression: job.cron },
    leaseMs: AGENT_JOB_LEASE_MS,
    run: (ctx: JobContext) => runAgentJob(job, ctx, runners, timeoutMs),
  };
}

async function runAgentJob(
  job: AgentJob,
  ctx: JobContext,
  runners: RunnerSet,
  timeoutMs: number,
): Promise<JobResult> {
  await failStaleRuns(ctx.db, job.id, new Date(ctx.now.getTime() - timeoutMs));
  const run = await startAgentJobRun(ctx.db, job.id, ctx.trigger, ctx.now);
  if (job.target.kind === "yarvis" && job.target.specialist === UNREADABLE_TARGET) {
    const message =
      "this job's agent configuration was written by another version and can't be read";
    await finishAgentJobRun(ctx.db, run.id, { status: "error", error: message });
    throw new Error(message);
  }
  const runner: AgentJobRunner = runners[job.target.kind];
  try {
    const result = await runner({
      config: ctx.config,
      db: ctx.db,
      target: job.target,
      prompt: job.prompt,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The output is model-composed from material the agent read, and it is
    // stored and shown; a provider error or a leaked env var reaching it would
    // be persisted, so it goes through the same redaction the scheduler applies
    // to error text.
    const output = truncateOutput(redactSecrets(result.output));
    await finishAgentJobRun(ctx.db, run.id, { status: "ok", output });
    await pruneAgentJobRuns(ctx.db, job.id);
    return { detail: `${job.name}: ${output.length} chars` };
  } catch (e) {
    const message = redactSecrets(e instanceof Error ? e.message : String(e));
    await finishAgentJobRun(ctx.db, run.id, { status: "error", error: message });
    await pruneAgentJobRuns(ctx.db, job.id);
    throw new Error(message);
  }
}

export interface AgentJobStatus {
  job: AgentJob;
  /** Null when the expression no longer parses, or will never fire again. */
  nextRunAt: Date | null;
  cronValid: boolean;
  lastRun: ScheduledJobRun | null;
  running: boolean;
}

/** A job plus what the panel shows beside it. */
export async function agentJobStatuses(db: Db, now: Date = new Date()): Promise<AgentJobStatus[]> {
  const jobs = await listAgentJobs(db);
  return Promise.all(
    jobs.map(async (job) => {
      const [lastRun] = await listAgentJobRuns(db, job.id, 1);
      // A run row is closed by the job's *next* run, so a job that was
      // interrupted and then paused would otherwise read "running" forever. Past
      // the timeout it cannot still be going, whatever the row says.
      const stale =
        lastRun?.startedAt && now.getTime() - lastRun.startedAt.getTime() > RUN_TIMEOUT_MS;
      return {
        job,
        cronValid: isValidCron(job.cron),
        nextRunAt: job.enabled ? nextCronRun(job.cron, now) : null,
        lastRun: lastRun ?? null,
        running: lastRun?.status === "running" && !stale,
      };
    }),
  );
}
