import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { prUpdateWatches } from "../db/schema.ts";

/**
 * Records that the user opened a PR's Since last review tab, which lets the
 * `pr-updates` job start another "What's changed" run for it (`updates.ts`).
 * A PR the job doesn't watch has no row, and nothing is written.
 */
export async function noteSinceReviewTabOpened(db: Db, refKey: string): Promise<void> {
  await db
    .update(prUpdateWatches)
    .set({ tabOpenedAt: new Date() })
    .where(eq(prUpdateWatches.refKey, refKey));
}
