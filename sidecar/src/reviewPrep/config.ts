import { readSection } from "../settings/store.ts";

/** Review prep's settings, at the `reviewPrep` key in `~/.yarvis/settings.json`. */
export interface ReviewPrepConfig {
  /**
   * How many PRs review prep verifies at once. Each PR's checks are a dozen
   * Claude Code runs, so this stays small; the rest wait their turn.
   */
  maxConcurrentVerifications: number;
  /**
   * How many PRs may be prepared or being prepared at once, so the user gets
   * a steady stream of reviews rather than a pile. Further PRs wait in a
   * backlog. A stack is started whole even past this.
   */
  maxReady: number;
}

export const DEFAULT_REVIEW_PREP_CONFIG: ReviewPrepConfig = {
  maxConcurrentVerifications: 2,
  maxReady: 5,
};

/** Hand-edited values outside these ranges are clamped rather than refused. */
const MAX_CONCURRENT = 5;
const MAX_READY = 50;

const SETTINGS_KEY = "reviewPrep";

function clamped(raw: unknown, fallback: number, max: number): number {
  const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(max, Math.max(1, value));
}

export async function getReviewPrepConfig(): Promise<ReviewPrepConfig> {
  const stored = await readSection<Partial<ReviewPrepConfig>>(SETTINGS_KEY).catch(() => undefined);
  return {
    maxConcurrentVerifications: clamped(
      stored?.maxConcurrentVerifications,
      DEFAULT_REVIEW_PREP_CONFIG.maxConcurrentVerifications,
      MAX_CONCURRENT,
    ),
    maxReady: clamped(stored?.maxReady, DEFAULT_REVIEW_PREP_CONFIG.maxReady, MAX_READY),
  };
}
