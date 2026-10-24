import { ensureOk, sidecarFetch } from "../api";
import { refKey } from "../pr/ref";
import type { PrRef, SeenCommits } from "../pr/types";
import {
  invalidatePrefix,
  PROVIDER_FRESHNESS,
  type Resource,
  SIDECAR_FRESHNESS,
  useCachedResource,
} from "../resourceCache";
import type { ReviewChangedFile, ReviewWorkspacePr } from "./api";
import { AT_COMMIT, reviewWorkspacePrefix } from "./cache";

/**
 * "What changed since I last reviewed": the client for the review marks and
 * the since-review, commit and interdiff reads of `/api/review-workspaces`,
 * plus the classic page's `/api/pr/review-mark`, and their cached hooks.
 */

export type ReviewMarkSource = "review" | "comment" | "manual" | "provider";

/** Where the user last reviewed a PR: the head they were looking at. */
export interface ReviewMark {
  headSha: string;
  baseSha: string | null;
  mergeBaseSha: string | null;
  source: ReviewMarkSource;
  createdAt: string;
}

export interface LastReview {
  mark: ReviewMark | null;
  /** The review clone has the mark's commit; null before the PR is cloned. */
  shaExists: boolean | null;
  headSha: string | null;
  /** The mark is at the checkout's head. */
  upToDate: boolean;
}

export interface ReviewCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  parents: string[];
  /** The reviewed head had neither this commit nor one with the same change. */
  isNew: boolean;
  /** The reviewed commit a rebase re-created as this one. */
  rebasedFrom?: string;
}

/** `added`: touched now, not then; `modified`: changed differently; `reverted`: left alone now. */
export type SinceStatus = "added" | "modified" | "reverted";

export interface SinceFile {
  path: string;
  oldPath?: string;
  status: SinceStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  tooLarge: boolean;
}

export interface SinceReview {
  fromHeadSha: string;
  toHeadSha: string;
  fromMergeBase: string;
  toMergeBase: string;
  /** History was rewritten since the review (a rebase or force-push). */
  rebased: boolean;
  /** The PR now sits on a newer base (rebased onto it, or merged it in). */
  baseMoved: boolean;
  mark: ReviewMark | null;
  files: SinceFile[];
  filesTruncated: boolean;
  commits: ReviewCommit[];
  /** Reviewed commits with no counterpart now: dropped or rewritten. */
  removedCommits: ReviewCommit[];
  commitsTruncated: boolean;
}

export interface FileSide {
  content: string;
  binary: boolean;
  tooLarge: boolean;
  size: number;
}

/**
 * How the left side of a since-review diff was made: `direct` is the reviewed
 * file as it was; `carried` is the reviewed change moved onto today's base, so
 * upstream edits don't show; `upstream-included` is the reviewed file as it
 * was because upstream rewrote the lines the PR changed.
 */
export type CarriedMode = "direct" | "carried" | "upstream-included";

export interface SinceFileView {
  path: string;
  oldPath?: string;
  status: SinceStatus;
  mode: CarriedMode;
  fromHeadSha: string;
  toHeadSha: string;
  original: FileSide | null;
  modified: FileSide | null;
  patch: string;
  additions: number;
  deletions: number;
  tooLarge: boolean;
}

export interface PrCommits {
  headSha: string;
  mergeBaseSha: string;
  fromHeadSha: string | null;
  commits: ReviewCommit[];
  truncated: boolean;
}

export interface CommitFiles {
  sha: string;
  parentSha: string;
  files: ReviewChangedFile[];
}

export interface CommitFileDiff {
  sha: string;
  parentSha: string;
  path: string;
  oldPath?: string;
  status: ReviewChangedFile["status"];
  original: FileSide | null;
  modified: FileSide | null;
  patch: string;
  tooLarge: boolean;
}

/** How far the PR has moved since the last review, as the provider sees it. */
export interface ProviderReviewMark {
  mark: ReviewMark | null;
  headSha: string | null;
  since: { exists: boolean; commits: number | null; rewritten: boolean } | null;
}

const BASE = "/api/review-workspaces";
const prPath = (workspaceId: string, prId: string) => `${BASE}/${workspaceId}/prs/${prId}`;

async function json<T>(path: string, context: string, init?: RequestInit): Promise<T> {
  const res = await sidecarFetch(path, init);
  await ensureOk(res, context);
  return res.json() as Promise<T>;
}

const withFrom = (params: URLSearchParams, from?: string) => {
  if (from) params.set("from", from);
  const query = params.toString();
  return query ? `?${query}` : "";
};

export function lastReview(workspaceId: string, prId: string) {
  return json<LastReview>(`${prPath(workspaceId, prId)}/last-review`, "read last review");
}

/** "Mark reviewed here": records the checkout's head as reviewed. */
export function markReviewedHere(workspaceId: string, prId: string) {
  return json<ReviewMark>(`${prPath(workspaceId, prId)}/review-mark`, "mark reviewed", {
    method: "POST",
  });
}

export function sinceReview(workspaceId: string, prId: string, from?: string) {
  return json<SinceReview>(
    `${prPath(workspaceId, prId)}/since-review${withFrom(new URLSearchParams(), from)}`,
    "read changes since review",
  );
}

export function sinceReviewFile(workspaceId: string, prId: string, path: string, from?: string) {
  return json<SinceFileView>(
    `${prPath(workspaceId, prId)}/since-review/file${withFrom(new URLSearchParams({ path }), from)}`,
    "read change since review",
  );
}

export function prCommits(workspaceId: string, prId: string, from?: string) {
  return json<PrCommits>(
    `${prPath(workspaceId, prId)}/commits${withFrom(new URLSearchParams(), from)}`,
    "list commits",
  );
}

export function commitFiles(workspaceId: string, prId: string, sha: string) {
  return json<CommitFiles>(`${prPath(workspaceId, prId)}/commits/${sha}/diff`, "read commit");
}

export function commitFileDiff(workspaceId: string, prId: string, sha: string, path: string) {
  const query = new URLSearchParams({ path });
  return json<CommitFileDiff>(
    `${prPath(workspaceId, prId)}/commits/${sha}/diff?${query}`,
    "read commit diff",
  );
}

/** The classic page's read: the last review wherever it was made, and how far the PR moved. */
export function providerReviewMark(ref: PrRef, head?: string) {
  const params = new URLSearchParams(
    ref.provider === "github"
      ? { provider: "github", owner: ref.owner, repo: ref.repo, number: String(ref.number) }
      : {
          provider: "azure",
          org: ref.org,
          project: ref.project,
          repo: ref.repo,
          prId: String(ref.prId),
        },
  );
  if (head) params.set("head", head);
  return json<ProviderReviewMark>(`/api/pr/review-mark?${params}`, "read last review");
}

/** What a review or comment from a review workspace says it looked at: the checkout. */
export function seenAt(
  pr: Pick<ReviewWorkspacePr, "headSha" | "baseSha" | "mergeBaseSha">,
): SeenCommits {
  return { headSha: pr.headSha, baseSha: pr.baseSha, mergeBaseSha: pr.mergeBaseSha };
}

// --- Cached hooks --------------------------------------------------------------

type PrShas = Pick<ReviewWorkspacePr, "id" | "headSha" | "mergeBaseSha">;

/**
 * Every last-review answer for one PR starts with this. Keyed by the PR rather
 * than by a workspace row, because what moves it — a review, a comment, a mark
 * — happens to the pull request, from whichever surface.
 */
export const reviewMarkPrefix = (ref: PrRef) => `review-mark:${refKey(ref)}:`;

/** Not pinned to a commit: a review, a comment or "Mark reviewed here" moves it. */
export const lastReviewKey = (pr: Pick<ReviewWorkspacePr, "id" | "ref">) =>
  `${reviewMarkPrefix(pr.ref)}ws:${pr.id}`;

export function useLastReview(
  workspaceId: string,
  pr: PrShas & Pick<ReviewWorkspacePr, "ref">,
): Resource<LastReview> {
  return useCachedResource(
    pr.headSha ? lastReviewKey(pr) : null,
    () => lastReview(workspaceId, pr.id),
    SIDECAR_FRESHNESS,
  );
}

/**
 * The classic page's answer. Keyed by the head the page has, which is part of
 * the question; held like a provider read, since answering it is one.
 */
export function useProviderReviewMark(
  ref: PrRef | null,
  head: string | null,
): Resource<ProviderReviewMark> {
  return useCachedResource(
    ref && head ? `${reviewMarkPrefix(ref)}provider:${head}` : null,
    () => providerReviewMark(ref as PrRef, head as string),
    PROVIDER_FRESHNESS,
  );
}

/** Pinned by both ends of the comparison, so it never goes stale. */
export function useSinceReview(
  workspaceId: string,
  pr: PrShas,
  from: string | null,
): Resource<SinceReview> {
  const key =
    from && pr.headSha && pr.mergeBaseSha
      ? `${reviewWorkspacePrefix(pr.id)}since:${from}..${pr.mergeBaseSha}..${pr.headSha}`
      : null;
  return useCachedResource(key, () => sinceReview(workspaceId, pr.id, from as string), AT_COMMIT);
}

export function useSinceReviewFile(
  workspaceId: string,
  pr: PrShas,
  path: string,
  from: string,
): Resource<SinceFileView> {
  const key =
    pr.headSha && pr.mergeBaseSha
      ? `${reviewWorkspacePrefix(pr.id)}since-file:${from}..${pr.mergeBaseSha}..${pr.headSha}:${path}`
      : null;
  return useCachedResource(key, () => sinceReviewFile(workspaceId, pr.id, path, from), AT_COMMIT);
}

/** The PR's commits, flagged new since `from` when there is one. */
export function usePrCommits(
  workspaceId: string,
  pr: PrShas,
  from: string | null,
): Resource<PrCommits> {
  const key =
    pr.headSha && pr.mergeBaseSha
      ? `${reviewWorkspacePrefix(pr.id)}commits:${pr.mergeBaseSha}..${pr.headSha}:${from ?? "-"}`
      : null;
  return useCachedResource(key, () => prCommits(workspaceId, pr.id, from ?? undefined), AT_COMMIT);
}

export function useCommitFiles(workspaceId: string, prId: string, sha: string) {
  return useCachedResource(
    `${reviewWorkspacePrefix(prId)}commit:${sha}`,
    () => commitFiles(workspaceId, prId, sha),
    AT_COMMIT,
  );
}

export function useCommitFileDiff(
  workspaceId: string,
  prId: string,
  sha: string,
  path: string | null,
) {
  return useCachedResource(
    path ? `${reviewWorkspacePrefix(prId)}commit:${sha}:${path}` : null,
    () => commitFileDiff(workspaceId, prId, sha, path as string),
    AT_COMMIT,
  );
}

/** Drops every last-review answer for a PR after something moved it (a review, a comment, a mark). */
export function invalidateLastReview(ref: PrRef): void {
  invalidatePrefix(reviewMarkPrefix(ref));
}
