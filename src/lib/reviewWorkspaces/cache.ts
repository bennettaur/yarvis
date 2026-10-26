import {
  type Freshness,
  invalidate,
  invalidatePrefix,
  type Resource,
  useCachedResource,
} from "../resourceCache";
import {
  getReviewWorkspace,
  listReviewWorkspaces,
  type ReviewChangedFiles,
  type ReviewWorkspace,
  type ReviewWorkspacePr,
  type ReviewWorkspaceSummary,
  reviewChangedFiles,
} from "./api";

/** The review workspaces' keys in `lib/resourceCache`. */
export const REVIEW_WORKSPACES_KEY = "review-workspaces:list";
export const reviewWorkspaceKey = (id: string) => `review-workspaces:one:${id}`;

/**
 * A read pinned to a commit can't go stale: the key names the commit, so a
 * refreshed PR asks a different question rather than getting an old answer.
 * Nothing about it needs re-checking, so nothing is spent re-checking it.
 */
export const AT_COMMIT: Freshness = {
  ttlMs: Number.POSITIVE_INFINITY,
  hardMs: Number.POSITIVE_INFINITY,
};

/** Every key read from a PR's checkout starts with this, so a refresh can drop them all. */
export const reviewWorkspacePrefix = (prId: string) => `review-ws:${prId}:`;

type PrShas = Pick<ReviewWorkspacePr, "id" | "headSha" | "mergeBaseSha">;

/** Null until the PR's commits are fetched, since there is nothing to diff before. */
export const changedFilesKey = (pr: PrShas) =>
  pr.headSha && pr.mergeBaseSha
    ? `${reviewWorkspacePrefix(pr.id)}changed:${pr.mergeBaseSha}..${pr.headSha}`
    : null;

/** With `archived`, the list holds the archived workspaces too. */
export function useReviewWorkspaces(archived = false): Resource<ReviewWorkspaceSummary[]> {
  return useCachedResource(
    archived ? `${REVIEW_WORKSPACES_KEY}:archived` : REVIEW_WORKSPACES_KEY,
    () => listReviewWorkspaces({ archived }),
  );
}

export function useReviewWorkspace(id: string | null): Resource<ReviewWorkspace> {
  return useCachedResource(id ? reviewWorkspaceKey(id) : null, () =>
    getReviewWorkspace(id as string),
  );
}

/** The files the PR changes, shared by the nav, the trees and every tab. */
export function useReviewChangedFiles(
  workspaceId: string,
  pr: PrShas | null,
): Resource<ReviewChangedFiles> {
  return useCachedResource(
    pr ? changedFilesKey(pr) : null,
    () => reviewChangedFiles(workspaceId, (pr as PrShas).id),
    AT_COMMIT,
  );
}

/** Drops what a change to one workspace makes stale: it, and the list it sits in. */
export function invalidateReviewWorkspace(id: string): void {
  invalidate(reviewWorkspaceKey(id));
  invalidatePrefix(REVIEW_WORKSPACES_KEY);
}
