/**
 * Provider-neutral pull-request shapes shared by the GitHub and Azure DevOps
 * clients. Both providers map their native API responses onto these types so
 * the frontend renders a single PR review view regardless of source.
 */

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

export interface ChecksSummary {
  total: number;
  success: number;
  failure: number;
  pending: number;
}

export interface PrStatus {
  mergeable: boolean | null;
  mergeableState: string;
  checks: ChecksSummary;
}

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
  additions: number;
  deletions: number;
  /** GraphQL/Azure mergeable enum: "MERGEABLE" | "CONFLICTING" | "UNKNOWN". */
  mergeable: string;
  checks: CheckItem[];
  reviewThreads: ReviewThread[];
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

/**
 * The data-returning contract both provider clients satisfy. Identity is
 * provider-specific (GitHub owner/repo/number vs Azure org/project/repo/prId),
 * so it is carried by the `Ref` type parameter rather than fixed positional
 * arguments.
 */
export interface ProviderClient<Ref> {
  viewer(): Promise<Viewer>;
  search(scope: string): Promise<PrSummary[]>;
  prStatus(ref: Ref): Promise<PrStatus>;
  /** Includes review threads, so no separate thread fetch is needed. */
  prDetail(ref: Ref): Promise<PrDetail>;
  prFiles(ref: Ref): Promise<PrFile[]>;
  postComment(ref: Ref, input: NewComment): Promise<void>;
}
