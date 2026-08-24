import { eq, gt, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type SuggestionDismissal, suggestionDismissals } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

/**
 * Suggestions the user has turned down.
 *
 * When they say "not that one", that has to stick, or the next "what should I
 * work on" offers the same PR again and the assistant looks like it wasn't
 * listening. Structured rather than a memory because the suggester filters on an
 * exact key, and semantic recall is the wrong instrument for "is this specific
 * pull request dismissed".
 */

export interface RecordDismissalInput {
  /** Stable key for the thing dismissed, e.g. `gh:owner/repo/12`, `todo:<id>`. */
  refKey: string;
  reason?: string | null;
  /** When the dismissal lapses. Null means indefinitely. */
  expiresAt?: Date | null;
}

/** Records a dismissal, replacing any earlier one for the same thing. */
export async function recordDismissal(
  db: Db,
  input: RecordDismissalInput,
): Promise<SuggestionDismissal> {
  const [row] = await db
    .insert(suggestionDismissals)
    .values({
      refKey: input.refKey,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .onConflictDoUpdate({
      target: suggestionDismissals.refKey,
      set: {
        reason: input.reason ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: new Date(),
      },
    })
    .returning();
  await emitEvent(db, {
    type: "suggestion.dismissed",
    source: "digest",
    payload: { refKey: input.refKey, reason: input.reason ?? null },
  });
  return row!;
}

/** The dismissals still in force, newest first. */
export async function activeDismissals(
  db: Db,
  now: Date = new Date(),
): Promise<SuggestionDismissal[]> {
  return db
    .select()
    .from(suggestionDismissals)
    .where(or(isNull(suggestionDismissals.expiresAt), gt(suggestionDismissals.expiresAt, now)));
}

/** Keys currently dismissed, for filtering a candidate list. */
export async function dismissedKeys(db: Db, now: Date = new Date()): Promise<Set<string>> {
  return new Set((await activeDismissals(db, now)).map((d) => d.refKey));
}

/** Lifts a dismissal, so the thing can be suggested again. */
export async function clearDismissal(db: Db, refKey: string): Promise<boolean> {
  const deleted = await db
    .delete(suggestionDismissals)
    .where(eq(suggestionDismissals.refKey, refKey))
    .returning({ id: suggestionDismissals.id });
  return deleted.length > 0;
}
