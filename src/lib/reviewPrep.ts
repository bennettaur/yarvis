import { ensureOk, sidecarFetch } from "./api";
import type { RiskLevel } from "./attention";

/** The review-prep states that hold a slot, mirroring the sidecar's `SLOT_STATES`. */
export type SlotState = "queued" | "verifying" | "ready" | "needs-go-ahead";

/** Review prep's stream of PRs for the user to review (`/api/review-prep/stream`), mirroring the sidecar. */
export interface ReviewStream {
  /** How many PRs may be prepared or being prepared at once. */
  maxReady: number;
  /** The PRs holding a slot. A stack can take more than `maxReady`. */
  slots: { pr: string; state: SlotState; risk: RiskLevel | null }[];
  /** Oldest first, which is the order they start in. */
  backlog: { pr: string; backloggedAt: string | null }[];
}

export const REVIEW_STREAM_CACHE_KEY = "review-prep:stream";

export async function getReviewStream(): Promise<ReviewStream> {
  const res = await sidecarFetch("/api/review-prep/stream");
  await ensureOk(res, "load the review stream");
  return res.json();
}
