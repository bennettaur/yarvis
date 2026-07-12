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
