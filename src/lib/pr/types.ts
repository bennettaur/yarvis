/**
 * Provider-neutral pull-request shapes for the frontend. Identity lives in a
 * discriminated `PrRef`, so one set of components renders PRs from either
 * GitHub or Azure DevOps.
 */

export type Provider = "github" | "azure";

/** Discriminated PR identity. The org is implicit (server config) for Azure. */
export type PrRef =
  | { provider: "github"; owner: string; repo: string; number: number }
  | { provider: "azure"; org: string; project: string; repo: string; prId: number };

export interface PrSummary {
  ref: PrRef;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  state: string;
  createdAt: string;
  updatedAt: string;
}

export interface PrStatus {
  mergeable: boolean | null;
  mergeableState: string;
  checks: { total: number; success: number; failure: number; pending: number };
}

/**
 * A PR the user has engaged with, plus their own footprint on it. Backs the
 * "Reviewing" list, where a merged PR or the user's own approval means the
 * review is done.
 */
export interface PrInvolvement {
  summary: PrSummary;
  merged: boolean;
  /** The user's submitted review verdicts, oldest first. */
  myReviewStates: ReviewerState[];
}

/** The "Reviewing" list, split into work still owed and work that has landed. */
export interface ReviewingList {
  inProgress: PrInvolvement[];
  complete: PrInvolvement[];
}

/** User configuration for the GitHub PR dashboard (mirrors the sidecar shape). */
export interface GhPrConfig {
  /** GitHub search driving the "Needs review" list. */
  reviewQuery: string;
  /** How far back the "Reviewing" list looks for PRs the user has touched. */
  reviewingLookbackDays: number;
}

export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
}

export interface CheckItem {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

/**
 * Provider-neutral reviewer verdict. `pending` covers both "requested but not
 * yet reviewed" and "vote reset"; `isRequested` distinguishes an outstanding
 * request from a review that was submitted and then dismissed.
 */
export type ReviewerState =
  | "approved"
  | "changes_requested"
  | "commented"
  | "pending"
  | "dismissed";

export interface Reviewer {
  login: string;
  state: ReviewerState;
  isRequested: boolean;
}

/** A merge strategy the repo allows, in GitHub's GraphQL vocabulary. */
export type MergeMethod = "MERGE" | "SQUASH" | "REBASE";

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  /** True when `headRef` lives in a fork rather than in the repo the PR targets. */
  fromFork: boolean;
  /**
   * Commit the PR currently points at. Anchors anything derived from the code
   * as it stands right now — expanded file context, generated review material —
   * so a later push can be detected as having moved the ground underneath it.
   * Empty when the provider hasn't reported one yet.
   */
  headSha: string;
  additions: number;
  deletions: number;
  mergeable: string;
  /**
   * Merge methods the repo permits, so the UI only offers valid ones. Empty
   * when the provider doesn't expose them (Azure) — merge buttons stay hidden.
   */
  mergeMethods: MergeMethod[];
  /** True when auto-merge is already armed on the PR. */
  autoMergeEnabled: boolean;
  /** Viewer may arm auto-merge (repo allows it, viewer has permission). */
  canEnableAutoMerge: boolean;
  /** Viewer may cancel an already-armed auto-merge. */
  canDisableAutoMerge: boolean;
  checks: CheckItem[];
  reviewThreads: ReviewThread[];
  /** Requested reviewers plus anyone who has already submitted a review. */
  reviewers: Reviewer[];
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

/** A single-line comment the user wants to post. */
export interface NewComment {
  path: string;
  line: number;
  body: string;
  side?: "RIGHT" | "LEFT";
}

/** A saved GitHub search (free-text query). */
export interface GhFilter {
  id: string;
  name: string;
  query: string;
  createdAt: string;
}

/** A saved Azure DevOps search (structured scope + optional project). */
export interface AzFilter {
  id: string;
  name: string;
  scope: "mine" | "review";
  project: string | null;
  createdAt: string;
}

/** A starred PR, normalized to its ref plus display fields. */
export interface StarredPr {
  ref: PrRef;
  title: string | null;
  url: string | null;
}
