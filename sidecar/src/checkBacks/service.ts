import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type ChatCheckBack, chatCheckBacks } from "../db/schema.ts";

/**
 * Check-backs: prompts the chat agent leaves for itself to run later in the same
 * chat. "Tell me when CI goes green" becomes a check now, and — if it isn't
 * green yet — a check-back that looks again in a few minutes and either reports
 * or schedules the next one.
 */

/**
 * How many times a chain may re-schedule itself. A CI run checked every ten
 * minutes for four hours fits; a condition that never comes true stops costing
 * model calls once this is reached.
 */
export const MAX_CHECK_BACK_ATTEMPTS = 24;

/** Pending check-backs one chat may hold, so a confused turn can't queue dozens. */
export const MAX_PENDING_PER_SESSION = 5;

/** The scheduler ticks once a minute, so a shorter delay would not fire sooner. */
export const MIN_DELAY_MINUTES = 1;

export const MAX_DELAY_MINUTES = 7 * 24 * 60;

/** Cap on the prompt, which is replayed into the chat as a turn of its own. */
export const MAX_PROMPT_CHARS = 2_000;

export interface ScheduleCheckBackInput {
  sessionId: string;
  prompt: string;
  delayMinutes: number;
  provider: string | null;
  model: string | null;
  attempt: number;
}

export type ScheduleCheckBackResult = { checkBack: ChatCheckBack } | { error: string };

export async function scheduleCheckBack(
  db: Db,
  input: ScheduleCheckBackInput,
  now: Date = new Date(),
): Promise<ScheduleCheckBackResult> {
  if (input.attempt > MAX_CHECK_BACK_ATTEMPTS) {
    return {
      error: `this has been checked ${MAX_CHECK_BACK_ATTEMPTS} times already; tell the user it still isn't done instead of scheduling another check`,
    };
  }
  const pending = await listPendingCheckBacks(db, input.sessionId);
  if (pending.length >= MAX_PENDING_PER_SESSION) {
    return {
      error: `this chat already has ${MAX_PENDING_PER_SESSION} pending check-backs; cancel one first`,
    };
  }
  const [checkBack] = await db
    .insert(chatCheckBacks)
    .values({
      sessionId: input.sessionId,
      prompt: input.prompt,
      provider: input.provider,
      model: input.model,
      attempt: input.attempt,
      dueAt: new Date(now.getTime() + input.delayMinutes * 60_000),
    })
    .returning();
  return { checkBack };
}

/** Soonest first. */
export async function listPendingCheckBacks(db: Db, sessionId: string): Promise<ChatCheckBack[]> {
  return db
    .select()
    .from(chatCheckBacks)
    .where(and(eq(chatCheckBacks.sessionId, sessionId), eq(chatCheckBacks.status, "pending")))
    .orderBy(asc(chatCheckBacks.dueAt));
}

/**
 * Cancels a pending check-back. Scoped to the chat, so a turn can only cancel
 * what its own conversation scheduled.
 */
export async function cancelCheckBack(db: Db, sessionId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(chatCheckBacks)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(chatCheckBacks.id, id),
        eq(chatCheckBacks.sessionId, sessionId),
        eq(chatCheckBacks.status, "pending"),
      ),
    )
    .returning();
  return rows.length > 0;
}

/**
 * Marks the due check-backs fired and returns them, oldest first.
 *
 * Fired before the turn runs, not after: a sidecar that dies mid-turn then loses
 * one check rather than replaying it into the chat on every restart.
 */
export async function claimDueCheckBacks(
  db: Db,
  now: Date,
  limit: number,
): Promise<ChatCheckBack[]> {
  const due = db
    .select({ id: chatCheckBacks.id })
    .from(chatCheckBacks)
    .where(and(eq(chatCheckBacks.status, "pending"), lte(chatCheckBacks.dueAt, now)))
    .orderBy(asc(chatCheckBacks.dueAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  const rows = await db
    .update(chatCheckBacks)
    .set({ status: "fired", firedAt: now })
    .where(and(inArray(chatCheckBacks.id, due), eq(chatCheckBacks.status, "pending")))
    .returning();
  return rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

export async function recordCheckBackError(db: Db, id: string, error: string): Promise<void> {
  await db.update(chatCheckBacks).set({ error }).where(eq(chatCheckBacks.id, id));
}
