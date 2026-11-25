import { ensureOk, sidecarFetch } from "../api";
import type { ReportSection } from "./verification";

/**
 * Client for the reviewer's feedback on a verification report's items:
 * whether each was right, why not, and what they did with it. The weekly
 * review reflection reads what is saved here to tune the checks.
 */

/** Mirrors the sidecar's `FEEDBACK_KINDS` (`reviewWorkspaces/feedback.ts`). */
export type FeedbackKind =
  | "summary"
  | "mustRead"
  | "mustReadFlag"
  | "theme"
  | "claim"
  | "gap"
  | "change"
  | "concern"
  | "finding"
  | "approach";

export type FeedbackVerdict = "accepted" | "rejected" | "rerated";
export type FeedbackAction = "posted-pr" | "added-workspace" | "asked";
export type FeedbackRating = "none" | "low" | "medium" | "high";

/** An item as the report showed it, stored with the feedback. */
export interface FeedbackItem {
  title: string;
  detail: string;
  rating?: string;
  path?: string;
  line?: number;
}

/** Mirrors the sidecar's `FeedbackResponse`. */
export interface ReportFeedback {
  id: string;
  runId: string | null;
  section: string;
  kind: string;
  itemKey: string;
  verdict: FeedbackVerdict | null;
  rating: FeedbackRating | null;
  reason: string | null;
  actions: FeedbackAction[];
  updatedAt: string;
}

export interface FeedbackInput {
  runId: string;
  section: ReportSection;
  kind: FeedbackKind;
  itemKey: string;
  item: FeedbackItem;
  /** Null clears the verdict. */
  verdict?: FeedbackVerdict | null;
  rating?: FeedbackRating;
  reason?: string;
  action?: FeedbackAction;
}

/** Which item feedback is about, within one run's section: its kind, text and place. */
export const feedbackItemKey = (kind: FeedbackKind, item: FeedbackItem) =>
  [kind, item.title, item.path ?? "", item.line ?? ""].join(":");

const path = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/verification/feedback`;

export async function verificationFeedback(
  workspaceId: string,
  prId: string,
): Promise<ReportFeedback[]> {
  const res = await sidecarFetch(path(workspaceId, prId));
  await ensureOk(res, "read report feedback");
  return ((await res.json()) as { feedback: ReportFeedback[] }).feedback;
}

export async function saveVerificationFeedback(
  workspaceId: string,
  prId: string,
  input: FeedbackInput,
): Promise<ReportFeedback> {
  const res = await sidecarFetch(path(workspaceId, prId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "save report feedback");
  return res.json();
}
