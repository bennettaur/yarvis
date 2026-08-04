/**
 * Provider dispatch for operations addressed by a {@link PrRef}. Each function
 * routes to the GitHub or Azure transport based on `ref.provider`, so the PR
 * components stay provider-agnostic.
 */

import {
  azAddStar,
  azFileContent,
  azMarkReady,
  azPostComment,
  azPrDetail,
  azPrFileDiff,
  azPrFiles,
  azPrStatus,
  azRemoveStar,
  azSubmitVote,
} from "./azure";
import {
  ghAddStar,
  ghDisableAutoMerge,
  ghEnableAutoMerge,
  ghFileContent,
  ghMarkReady,
  ghMergePr,
  ghPostComment,
  ghPrDetail,
  ghPrFiles,
  ghPrStatus,
  ghRemoveStar,
  ghSubmitReview,
} from "./github";
import type { MergeMethod, NewComment, PrDetail, PrFile, PrRef, PrStatus } from "./types";

export const fetchPrStatus = (ref: PrRef): Promise<PrStatus> =>
  ref.provider === "github" ? ghPrStatus(ref) : azPrStatus(ref);

export const fetchPrDetail = (ref: PrRef): Promise<PrDetail> =>
  ref.provider === "github" ? ghPrDetail(ref) : azPrDetail(ref);

export const fetchPrFiles = (ref: PrRef): Promise<PrFile[]> =>
  ref.provider === "github" ? ghPrFiles(ref) : azPrFiles(ref);

/**
 * One file's diff. GitHub returns patches in the file list, so the file is
 * already complete and no request is made. Azure builds the patch on demand.
 */
export const fetchPrFileDiff = (ref: PrRef, file: PrFile): Promise<PrFile> =>
  ref.provider === "github" ? Promise.resolve(file) : azPrFileDiff(ref, file.filename);

/**
 * A file's full text at a commit, used to reveal the unchanged code a patch
 * leaves out. The commit comes from the PR detail the caller already loaded.
 */
export const fetchPrFileContent = (ref: PrRef, path: string, sha: string): Promise<string> =>
  (ref.provider === "github" ? ghFileContent(ref, path, sha) : azFileContent(ref, path, sha)).then(
    (r) => r.content,
  );

export const postPrComment = (ref: PrRef, comment: NewComment): Promise<{ ok: boolean }> =>
  ref.provider === "github" ? ghPostComment(ref, comment) : azPostComment(ref, comment);

export const addStar = (ref: PrRef, title?: string | null, url?: string | null) =>
  ref.provider === "github" ? ghAddStar(ref, title, url) : azAddStar(ref, title, url);

export const removeStar = (ref: PrRef) =>
  ref.provider === "github" ? ghRemoveStar(ref) : azRemoveStar(ref);

/**
 * A provider-neutral review action. `approve` and `request_changes` map to the
 * provider's native vocabulary; `publish` lifts a draft to ready-for-review.
 */
export type ReviewAction = "publish" | "approve" | "request_changes";

/**
 * Apply a review action to a PR. The optional `body` is shown to the PR author
 * — required on `request_changes` for both providers (the sidecar enforces it,
 * but the UI should also gate the button).
 */
export async function applyReviewAction(
  ref: PrRef,
  action: ReviewAction,
  body?: string,
): Promise<void> {
  if (ref.provider === "github") {
    if (action === "publish") {
      await ghMarkReady(ref);
      return;
    }
    const event = action === "approve" ? "APPROVE" : "REQUEST_CHANGES";
    await ghSubmitReview(ref, event, body);
    return;
  }
  if (action === "publish") {
    await azMarkReady(ref);
    return;
  }
  // Azure votes are numeric: 10 = approved, -10 = rejected.
  const vote = action === "approve" ? 10 : -10;
  await azSubmitVote(ref, vote, body);
}

/**
 * Merge / auto-merge are GitHub-only for now — Azure's completion flow isn't
 * wired up, and its PR detail reports no merge methods, so the UI never offers
 * these on an Azure PR. The dispatch guards the boundary regardless.
 */
function requireGithub(ref: PrRef): void {
  if (ref.provider !== "github") {
    throw new Error("merge is only supported for GitHub pull requests");
  }
}

export function mergePr(ref: PrRef, method: MergeMethod): Promise<{ ok: boolean }> {
  requireGithub(ref);
  return ghMergePr(ref, method);
}

export function enableAutoMerge(ref: PrRef, method: MergeMethod): Promise<{ ok: boolean }> {
  requireGithub(ref);
  return ghEnableAutoMerge(ref, method);
}

export function disableAutoMerge(ref: PrRef): Promise<{ ok: boolean }> {
  requireGithub(ref);
  return ghDisableAutoMerge(ref);
}
