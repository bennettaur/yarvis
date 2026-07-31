import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { githubPrConfig } from "../db/schema.ts";

/**
 * Singleton store for the GitHub PR dashboard configuration. Modeled on the
 * work-in-progress config — at most one row, most recent wins, defaults apply
 * when no row exists.
 */

export interface GithubPrConfig {
  /** GitHub search driving the "Needs review" list. */
  reviewQuery: string;
  /** How far back the "Reviewing" list looks for PRs the user has touched. */
  reviewingLookbackDays: number;
}

/**
 * GitHub only surfaces review requests addressed to the viewer directly or via
 * one of their teams under `review-requested:@me`, which is the closest thing to
 * "needs my review" the search API offers. Users who want a narrower or wider
 * net override this.
 */
export const DEFAULT_REVIEW_QUERY = "is:open is:pr review-requested:@me";

/**
 * A month of history: long enough to pick up a review left open over a holiday,
 * short enough that the list doesn't turn into an archive.
 */
export const DEFAULT_REVIEWING_LOOKBACK_DAYS = 30;

export const DEFAULT_GITHUB_PR_CONFIG: GithubPrConfig = {
  reviewQuery: DEFAULT_REVIEW_QUERY,
  reviewingLookbackDays: DEFAULT_REVIEWING_LOOKBACK_DAYS,
};

export async function getGithubPrConfig(db: Db): Promise<GithubPrConfig> {
  const [row] = await db
    .select()
    .from(githubPrConfig)
    .orderBy(desc(githubPrConfig.updatedAt))
    .limit(1);
  if (!row) return DEFAULT_GITHUB_PR_CONFIG;
  return {
    reviewQuery: row.reviewQuery,
    reviewingLookbackDays: row.reviewingLookbackDays,
  };
}

/** Upserts the singleton config, keeping the table to one row. */
export async function saveGithubPrConfig(db: Db, input: GithubPrConfig): Promise<GithubPrConfig> {
  const values = {
    reviewQuery: input.reviewQuery,
    reviewingLookbackDays: input.reviewingLookbackDays,
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: githubPrConfig.id }).from(githubPrConfig).limit(1);
  if (existing) {
    await db.update(githubPrConfig).set(values).where(eq(githubPrConfig.id, existing.id));
  } else {
    await db.insert(githubPrConfig).values(values);
  }
  return getGithubPrConfig(db);
}
