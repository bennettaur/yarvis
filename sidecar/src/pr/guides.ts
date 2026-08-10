import { desc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type NewPrGuideRow, type PrGuideRow, type PrGuideStep, prGuides } from "../db/schema.ts";
import { type PrRef, refKey } from "./types.ts";

/**
 * Storage for generated review guides.
 *
 * A guide is worth keeping — it costs an agent run to produce, and a reviewer
 * comes back to a large PR over days — but only while the review is live. The
 * cleanup paths below are all driven by things the app already observes, so
 * there is no poller watching pull requests that have a guide: a review action
 * or a merge goes through this service on its way out, a detail load reports a
 * closed PR, and anything neither of those catches ages out of the sweep.
 */

/** A guide untouched for this long is assumed abandoned and swept. */
export const GUIDE_TTL_DAYS = 30;

export interface SaveGuideInput {
  ref: PrRef;
  headSha: string;
  steps: PrGuideStep[];
  title?: string | null;
  url?: string | null;
}

export async function getGuide(db: Db, ref: PrRef): Promise<PrGuideRow | null> {
  const [row] = await db
    .select()
    .from(prGuides)
    .where(eq(prGuides.refKey, refKey(ref)));
  return row ?? null;
}

/**
 * Writes a PR's guide, replacing any previous one. Regenerating after a push is
 * the common case, and keeping the old guide beside the new one would leave two
 * competing reading orders for the same pull request.
 */
export async function saveGuide(db: Db, input: SaveGuideInput): Promise<PrGuideRow> {
  const values: NewPrGuideRow = {
    refKey: refKey(input.ref),
    provider: input.ref.provider,
    title: input.title ?? null,
    url: input.url ?? null,
    headSha: input.headSha,
    steps: input.steps,
    currentStep: 0,
  };
  const [row] = await db
    .insert(prGuides)
    .values(values)
    .onConflictDoUpdate({
      target: prGuides.refKey,
      set: {
        provider: values.provider,
        title: values.title,
        url: values.url,
        headSha: values.headSha,
        steps: values.steps,
        // A new guide is a new reading order, so progress through the old one
        // no longer points anywhere meaningful.
        currentStep: 0,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

/**
 * Records how far the reviewer has read. The step is clamped to the guide, so a
 * client that has fallen behind a regeneration can't park progress past the end
 * of a now-shorter guide.
 */
export async function setGuideProgress(
  db: Db,
  ref: PrRef,
  step: number,
): Promise<PrGuideRow | null> {
  const guide = await getGuide(db, ref);
  if (!guide) return null;
  const clamped = Math.max(0, Math.min(step, guide.steps.length - 1));
  const [row] = await db
    .update(prGuides)
    .set({ currentStep: clamped, updatedAt: new Date() })
    .where(eq(prGuides.refKey, guide.refKey))
    .returning();
  return row ?? null;
}

export async function deleteGuide(db: Db, ref: PrRef): Promise<boolean> {
  const rows = await db
    .delete(prGuides)
    .where(eq(prGuides.refKey, refKey(ref)))
    .returning();
  return rows.length > 0;
}

/** Every guide, newest activity first. Backs the assistant's "what am I reviewing". */
export function listGuides(db: Db, limit = 50): Promise<PrGuideRow[]> {
  return db.select().from(prGuides).orderBy(desc(prGuides.updatedAt)).limit(limit);
}

/**
 * Drops guides nothing has touched in {@link GUIDE_TTL_DAYS}. The backstop for
 * pull requests closed on the provider's own site, which the app never sees.
 * Returns how many went.
 */
export async function sweepStaleGuides(db: Db, ttlDays = GUIDE_TTL_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);
  const rows = await db.delete(prGuides).where(lt(prGuides.updatedAt, cutoff)).returning();
  return rows.length;
}

/**
 * Drops a guide once its pull request is done with — merged, closed, or
 * reviewed. Called from the paths that perform those actions, so finishing a
 * review cleans up after itself.
 *
 * Failures are swallowed: not clearing a guide is untidy, but it must never be
 * the reason an approval or a merge reports failure to the user.
 */
export async function retireGuide(db: Db, ref: PrRef): Promise<void> {
  try {
    await deleteGuide(db, ref);
  } catch (e) {
    console.error("[pr] failed to retire guide:", e);
  }
}

/** True when the guide describes a commit the PR has since moved past. */
export function isStale(guide: PrGuideRow, headSha: string): boolean {
  // An empty head sha means the provider hasn't reported one; that is not
  // evidence the guide has gone stale, so it is left alone.
  return headSha !== "" && guide.headSha !== headSha;
}
