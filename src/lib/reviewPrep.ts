import { ensureOk, sidecarFetch } from "./api";
import type { RiskLevel } from "./attention";

/** Review prep's stream of PRs for the user to review (`/api/review-prep/stream`). */
export interface ReviewStream {
  /** How many PRs may be prepared or being prepared at once. */
  maxReady: number;
  /** The PRs holding a slot. A stack can take more than `maxReady`. */
  slots: { pr: string; state: string; risk: RiskLevel | null }[];
  /** Oldest first, which is the order they start in. */
  queue: { pr: string; queuedAt: string | null }[];
}

export const REVIEW_STREAM_CACHE_KEY = "review-prep:stream";

export async function getReviewStream(): Promise<ReviewStream> {
  const res = await sidecarFetch("/api/review-prep/stream");
  await ensureOk(res, "load the review stream");
  return res.json();
}
