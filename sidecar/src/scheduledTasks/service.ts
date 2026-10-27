import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type ChatScheduledTask, chatScheduledTasks } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";

/**
 * Scheduled tasks: prompts the assistant leaves for itself to run later in the
 * chat they came from. "I'm getting my PRs mergeable" can become a task that
 * checks on them in an hour; "this week's goals are…" can become a mid-week
 * check-in. A task watching something unfinished schedules the next one.
 */

/**
 * How many times a chain may re-schedule itself. A CI run checked every ten
 * minutes for four hours fits; a condition that never comes true stops costing
 * model calls once this is reached.
 */
export const MAX_SCHEDULED_TASK_ATTEMPTS = 24;

/** Pending tasks one chat may hold, so a confused turn can't queue dozens. */
export const MAX_PENDING_PER_SESSION = 5;

/** The scheduler ticks once a minute, so a shorter delay would not fire sooner. */
export const MIN_DELAY_MINUTES = 1;

/**
 * The shortest gap between runs of a chain. Each run replays the whole chat, so
 * a watch that re-checks every minute would spend a turn a minute for nothing.
 */
export const MIN_RESCHEDULE_DELAY_MINUTES = 5;

/**
 * Two weeks: far enough for "check in on Friday" from a Monday, or next week's
 * planning. Anything longer is better as a scheduled job the user can see.
 */
export const MAX_DELAY_MINUTES = 14 * 24 * 60;

/** Cap on the prompt, which is replayed into the chat as a turn of its own. */
export const MAX_PROMPT_CHARS = 2_000;

export const MAX_TITLE_CHARS = 80;

interface ScheduleTaskInput {
  sessionId: string;
  title: string;
  prompt: string;
  delayMinutes: number;
  origin: ChatScheduledTask["origin"];
  provider: string | null;
  model: string | null;
  attempt: number;
  parentId: string | null;
}

type ScheduleTaskResult = { scheduledTask: ChatScheduledTask } | { error: string };

export async function scheduleTask(
  db: Db,
  input: ScheduleTaskInput,
  now: Date = new Date(),
): Promise<ScheduleTaskResult> {
  if (input.attempt > MAX_SCHEDULED_TASK_ATTEMPTS) {
    return {
      error: `this chain has already run ${MAX_SCHEDULED_TASK_ATTEMPTS} times; tell the user it still isn't done instead of scheduling another task`,
    };
  }
  if (input.parentId && input.delayMinutes < MIN_RESCHEDULE_DELAY_MINUTES) {
    return {
      error: `schedule the next run at least ${MIN_RESCHEDULE_DELAY_MINUTES} minutes out`,
    };
  }
  const pending = await listPendingScheduledTasks(db, input.sessionId);
  if (pending.length >= MAX_PENDING_PER_SESSION) {
    return {
      error: `this chat already has ${MAX_PENDING_PER_SESSION} pending scheduled tasks; cancel one first`,
    };
  }
  const [scheduledTask] = await db
    .insert(chatScheduledTasks)
    .values({
      sessionId: input.sessionId,
      // Both are shown to the user and the prompt is replayed to the model; a
      // token the model copied out of a log must not be kept.
      title: redactSecrets(collapseWhitespace(input.title)),
      prompt: redactSecrets(input.prompt),
      origin: input.origin,
      provider: input.provider,
      model: input.model,
      attempt: input.attempt,
      parentId: input.parentId,
      dueAt: new Date(now.getTime() + input.delayMinutes * 60_000),
    })
    .returning();
  return { scheduledTask };
}

/** Earliest due first. */
export async function listPendingScheduledTasks(
  db: Db,
  sessionId: string,
): Promise<ChatScheduledTask[]> {
  return db
    .select()
    .from(chatScheduledTasks)
    .where(
      and(eq(chatScheduledTasks.sessionId, sessionId), eq(chatScheduledTasks.status, "pending")),
    )
    .orderBy(asc(chatScheduledTasks.dueAt));
}

/**
 * Cancels a pending task. Scoped to the chat, so a turn can only cancel what its
 * own conversation scheduled.
 */
export async function cancelScheduledTask(db: Db, sessionId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(chatScheduledTasks)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(chatScheduledTasks.id, id),
        eq(chatScheduledTasks.sessionId, sessionId),
        eq(chatScheduledTasks.status, "pending"),
      ),
    )
    .returning();
  return rows.length > 0;
}

/**
 * Marks the due tasks fired and returns them, earliest due first.
 *
 * Fired before the turn runs, not after: a sidecar that dies mid-turn then loses
 * one run rather than replaying it into the chat on every restart.
 */
export async function claimDueScheduledTasks(
  db: Db,
  now: Date,
  limit: number,
): Promise<ChatScheduledTask[]> {
  const due = db
    .select({ id: chatScheduledTasks.id })
    .from(chatScheduledTasks)
    .where(and(eq(chatScheduledTasks.status, "pending"), lte(chatScheduledTasks.dueAt, now)))
    .orderBy(asc(chatScheduledTasks.dueAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(chatScheduledTasks)
    .set({ status: "fired", firedAt: now })
    .where(and(inArray(chatScheduledTasks.id, due), eq(chatScheduledTasks.status, "pending")))
    .returning();
  return rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

export async function recordScheduledTaskError(db: Db, id: string, error: string): Promise<void> {
  await db.update(chatScheduledTasks).set({ error }).where(eq(chatScheduledTasks.id, id));
}

/** Whether the task's own turn scheduled the next run of its chain. */
export async function hasFollowUp(db: Db, scheduledTask: ChatScheduledTask): Promise<boolean> {
  const rows = await db
    .select({ id: chatScheduledTasks.id })
    .from(chatScheduledTasks)
    .where(
      and(
        eq(chatScheduledTasks.parentId, scheduledTask.id),
        eq(chatScheduledTasks.status, "pending"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** One line: a title with a newline in it could pose as a second header. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
