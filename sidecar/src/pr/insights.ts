import { desc, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NewPrInsightRow, type PrInsightRow, prInsights } from "../db/schema.ts";
import { type PrRef, refKey } from "./types.ts";

/**
 * Storage for answers to questions asked about specific lines of a review.
 *
 * Unlike guides these are not cleaned up when a review ends. An insight is a
 * note about why code is the way it is, and its value outlasts the pull request
 * that prompted it — it is the sort of thing the assistant should still be able
 * to find weeks later when the same code comes up again.
 */

export interface SaveInsightInput {
  ref: PrRef;
  path: string;
  startLine: number;
  endLine: number;
  headSha: string;
  question: string;
  answer: string;
}

export async function saveInsight(db: Db, input: SaveInsightInput): Promise<PrInsightRow> {
  const values: NewPrInsightRow = {
    refKey: refKey(input.ref),
    provider: input.ref.provider,
    path: input.path,
    startLine: input.startLine,
    endLine: input.endLine,
    headSha: input.headSha,
    question: input.question,
    answer: input.answer,
  };
  const [row] = await db.insert(prInsights).values(values).returning();
  return row!;
}

/** Every insight on a pull request, newest first. */
export function listInsights(db: Db, ref: PrRef): Promise<PrInsightRow[]> {
  return db
    .select()
    .from(prInsights)
    .where(eq(prInsights.refKey, refKey(ref)))
    .orderBy(desc(prInsights.createdAt));
}

/**
 * Finds insights whose question, answer, or path mentions `query`.
 *
 * A plain case-insensitive substring match rather than the pgvector search the
 * memory store uses: these are looked up by the thing the user remembers about
 * them — a file name, a function name, a phrase from their own question — and
 * an exact match on that is both cheaper and more predictable than the nearest
 * embedding. Escapes the LIKE wildcards so a path containing `_` matches
 * literally instead of as "any character".
 */
export function searchInsights(db: Db, query: string, limit = 10): Promise<PrInsightRow[]> {
  const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  return db
    .select()
    .from(prInsights)
    .where(
      or(
        ilike(prInsights.question, term),
        ilike(prInsights.answer, term),
        ilike(prInsights.path, term),
      ),
    )
    .orderBy(desc(prInsights.createdAt))
    .limit(limit);
}

export async function getInsight(db: Db, id: string): Promise<PrInsightRow | null> {
  const [row] = await db.select().from(prInsights).where(eq(prInsights.id, id));
  return row ?? null;
}

export async function deleteInsight(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(prInsights).where(eq(prInsights.id, id)).returning();
  return rows.length > 0;
}

/**
 * Stamps an insight as having been shared with the pull request's author. Only
 * ever set — an insight can't be un-posted, because the comment it produced is
 * on the provider and clearing the stamp here would just lose track of it.
 */
export async function markInsightPosted(db: Db, id: string): Promise<PrInsightRow | null> {
  const [row] = await db
    .update(prInsights)
    .set({ postedAt: new Date() })
    .where(eq(prInsights.id, id))
    .returning();
  return row ?? null;
}
