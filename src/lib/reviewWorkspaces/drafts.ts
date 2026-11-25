import { ensureOk, sidecarFetch } from "../api";
import type { SeenCommits } from "../pr/types";

/**
 * Client for a review PR's draft comments: comments Yarvis proposes on lines
 * of the diff, from the verification report or another reviewer, that the
 * user accepts, edits or drops. Nothing posts until the user posts them.
 */

export type ReviewDraftStatus = "open" | "accepted" | "dropped" | "posted";
export type ReviewDraftOutcome = "accepted" | "edited" | "dropped";

/** Mirrors the sidecar's `review_drafts` row. */
export interface ReviewDraft {
  id: string;
  /** What wrote it: `verification`, or another reviewer. */
  source: string;
  /** Where in the source it came from: a check's name, "Risk", "Looks off". */
  label: string;
  path: string;
  line: number;
  /** The commit `line` refers to. */
  headSha: string;
  title: string;
  /** The proposed text, model-written from the PR's code. */
  body: string;
  /** The user's text, when they changed the proposal. */
  editedBody: string | null;
  status: ReviewDraftStatus;
  outcome: ReviewDraftOutcome | null;
  /** The source no longer reports it at the PR's head. */
  stale: boolean;
}

export interface ReviewDrafts {
  headSha: string | null;
  drafts: ReviewDraft[];
}

const base = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/drafts`;

export async function listReviewDrafts(workspaceId: string, prId: string): Promise<ReviewDrafts> {
  const res = await sidecarFetch(base(workspaceId, prId));
  await ensureOk(res, "read draft comments");
  return (await res.json()) as ReviewDrafts;
}

export type DraftAnswer = { action: "accept"; body?: string } | { action: "drop" | "reopen" };

export async function answerReviewDraft(
  workspaceId: string,
  prId: string,
  draftId: string,
  answer: DraftAnswer,
): Promise<ReviewDraft> {
  const res = await sidecarFetch(`${base(workspaceId, prId)}/${draftId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(answer),
  });
  await ensureOk(res, "update the draft");
  return (await res.json()) as ReviewDraft;
}

/**
 * Posts every accepted draft as one review. Resolves with how many went up
 * and, when some didn't, why: Azure posts one thread at a time, so it can stop
 * part way.
 */
export async function postReviewDrafts(
  workspaceId: string,
  prId: string,
  summary: string,
  seen: SeenCommits,
): Promise<{ posted: number; error?: string }> {
  const commits = Object.fromEntries(Object.entries(seen).filter(([, v]) => typeof v === "string"));
  const res = await sidecarFetch(`${base(workspaceId, prId)}/post`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(summary.trim() && { summary }), ...commits }),
  });
  if (res.status === 502) return (await res.json()) as { posted: number; error?: string };
  await ensureOk(res, "post the review");
  return (await res.json()) as { posted: number };
}

/** The text a draft posts with. */
export const draftText = (d: Pick<ReviewDraft, "body" | "editedBody">) => d.editedBody ?? d.body;

/**
 * Drafts shown on their line in a file's diff: still undecided or accepted,
 * and made at the head on screen, since a line from another commit may point
 * at different code.
 */
export function inlineDrafts(
  drafts: readonly ReviewDraft[],
  path: string,
  headSha: string | null,
): ReviewDraft[] {
  return drafts.filter(
    (d) =>
      d.path === path &&
      !d.stale &&
      d.headSha === headSha &&
      (d.status === "open" || d.status === "accepted"),
  );
}
