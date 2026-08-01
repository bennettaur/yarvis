/**
 * Provider-neutral pull-request shapes shared by the GitHub and Azure DevOps
 * clients. Both providers map their native API responses onto these types so
 * the frontend renders a single PR review view regardless of source.
 */

/**
 * Discriminated PR identity, deliberately identical to the frontend's `PrRef`
 * so both sides derive the same {@link refKey} for the same pull request.
 *
 * The Azure routes don't receive an organization — the sidecar binds it from
 * configuration — so a route builds the ref by pairing the path parameters with
 * the configured org.
 */
export type PrRef =
  | { provider: "github"; owner: string; repo: string; number: number }
  | { provider: "azure"; org: string; project: string; repo: string; prId: number };

/**
 * Stable identity string. Must stay byte-for-byte in step with the frontend's
 * `refKey`: rows keyed by it are written by one side and read by the other.
 */
export function refKey(ref: PrRef): string {
  return ref.provider === "github"
    ? `gh:${ref.owner}/${ref.repo}/${ref.number}`
    : `az:${ref.org}/${ref.project}/${ref.repo}/${ref.prId}`;
}

/**
 * Rebuilds a ref from a stored {@link refKey}, for rows that carry the key
 * rather than the parts — an insight, say, that needs to be posted back to the
 * pull request it came from.
 *
 * Splitting on `/` is safe because every component is validated to exclude it
 * before a key is ever written. Returns null on anything that doesn't parse
 * rather than a half-built ref, so a malformed row fails where it is read
 * instead of somewhere downstream.
 */
export function parseRefKey(key: string): PrRef | null {
  const [prefix, ...rest] = key.split(":");
  const parts = rest.join(":").split("/");
  if (prefix === "gh" && parts.length === 3) {
    const number = Number(parts[2]);
    if (!parts[0] || !parts[1] || !Number.isInteger(number)) return null;
    return { provider: "github", owner: parts[0], repo: parts[1], number };
  }
  if (prefix === "az" && parts.length === 4) {
    const prId = Number(parts[3]);
    if (!parts[0] || !parts[1] || !parts[2] || !Number.isInteger(prId)) return null;
    return { provider: "azure", org: parts[0], project: parts[1], repo: parts[2], prId };
  }
  return null;
}

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  author: string;
  draft: boolean;
  state: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A PR plus the viewer's own footprint on it, used to build the "Reviewing"
 * list. `state` on the summary distinguishes open from closed; `merged`
 * separates a merged PR from one closed unmerged, and `myReviewStates` carries
 * the viewer's submitted verdicts so an approval can retire the PR from the
 * in-progress half of the list.
 */
export interface PrInvolvement {
  summary: PrSummary;
  merged: boolean;
  myReviewStates: ReviewerState[];
}

export interface ChecksSummary {
  total: number;
  success: number;
  failure: number;
  pending: number;
}

export interface PrStatus {
  /** "open" | "closed". */
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  checks: ChecksSummary;
}

/** A merge strategy the repo allows, in GitHub's GraphQL vocabulary. */
export type MergeMethod = "MERGE" | "SQUASH" | "REBASE";

/** A single review comment within a thread. */
export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
}

/** A review thread anchored to a file/line, with its comments. */
export interface ReviewThread {
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
}

/**
 * A reviewer on the PR, provider-neutral. Combines "requested but not yet
 * voted" and "already submitted a review" into a single list so the UI can
 * render one section that shows who's expected to weigh in and what they've
 * said so far. `state` captures the current verdict; `isRequested` marks a
 * reviewer whose review is still outstanding — a requested reviewer with no
 * review yet is `pending`, an approver whose approval was invalidated by a new
 * commit and re-requested is `pending` again.
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
  /** True when the reviewer's review is still outstanding (a fresh request). */
  isRequested: boolean;
}

/** A normalized CI check (CheckRun, commit status, or policy evaluation). */
export interface CheckItem {
  name: string;
  /** "COMPLETED" | "IN_PROGRESS" | "QUEUED" | "PENDING" … */
  status: string;
  /** "SUCCESS" | "FAILURE" | "NEUTRAL" | null while pending. */
  conclusion: string | null;
  url: string | null;
}

/** Rich detail for the in-app PR review view (description, checks, threads). */
export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  /**
   * Commit the PR currently points at. Anchors anything derived from the code
   * as it stands right now — expanded file context, generated review material —
   * so a later push can be detected as having moved the ground underneath it.
   * Empty when the provider hasn't reported one yet.
   */
  headSha: string;
  /** Commit the PR is diffed against; the counterpart to `headSha`. */
  baseSha: string;
  additions: number;
  deletions: number;
  /** GraphQL/Azure mergeable enum: "MERGEABLE" | "CONFLICTING" | "UNKNOWN". */
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

/** A changed file with its unified-diff patch (`patch` is null until loaded). */
export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

/** A line comment the user wants to post to a PR. */
export interface NewComment {
  path: string;
  line: number;
  body: string;
  /** Side of the diff the line belongs to; defaults to the new ("RIGHT") file. */
  side?: "RIGHT" | "LEFT";
}

export interface Viewer {
  login: string;
  /** Provider user id, when the provider needs one for search (Azure). */
  id?: string;
}
