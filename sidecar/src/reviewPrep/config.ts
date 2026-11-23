import { readSection } from "../settings/store.ts";

/** Review prep's settings, at the `reviewPrep` key in `~/.yarvis/settings.json`. */
export interface ReviewPrepConfig {
  /**
   * How many PRs review prep verifies at once. Each PR's checks are a dozen
   * Claude Code runs, so this stays small; the rest wait their turn.
   */
  maxConcurrentVerifications: number;
}

export const DEFAULT_REVIEW_PREP_CONFIG: ReviewPrepConfig = { maxConcurrentVerifications: 2 };

/** A hand-edited value outside this range is clamped rather than refused. */
const MAX_CONCURRENT = 5;

const SETTINGS_KEY = "reviewPrep";

export async function getReviewPrepConfig(): Promise<ReviewPrepConfig> {
  const stored = await readSection<Partial<ReviewPrepConfig>>(SETTINGS_KEY).catch(() => undefined);
  const raw = stored?.maxConcurrentVerifications;
  const value =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.round(raw)
      : DEFAULT_REVIEW_PREP_CONFIG.maxConcurrentVerifications;
  return { maxConcurrentVerifications: Math.min(MAX_CONCURRENT, Math.max(1, value)) };
}
