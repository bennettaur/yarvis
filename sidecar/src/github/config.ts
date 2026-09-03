import { readSection, withSection } from "../settings/store.ts";

/**
 * Singleton config for the GitHub PR dashboard, stored under the
 * `githubPrConfig` key in `~/.yarvis/settings.json`. Defaults apply when
 * nothing is stored.
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

const SETTINGS_KEY = "githubPrConfig";

export async function getGithubPrConfig(): Promise<GithubPrConfig> {
  const stored = await readSection<GithubPrConfig>(SETTINGS_KEY);
  return stored ?? DEFAULT_GITHUB_PR_CONFIG;
}

export async function saveGithubPrConfig(input: GithubPrConfig): Promise<GithubPrConfig> {
  return withSection<GithubPrConfig, GithubPrConfig>(SETTINGS_KEY, () => ({
    next: input,
    result: input,
  }));
}
