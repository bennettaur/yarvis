/**
 * Minimal Azure DevOps REST client over fetch (no SDK dependency). The fetch
 * implementation is injectable so response shaping can be unit-tested, mirroring
 * the GitHub client.
 *
 * Identity differs from GitHub: a PR is addressed by project + repository (name
 * accepted in the `repositoryId` slot) + pull-request id. The organization is
 * fixed by the configured org URL, so it is held on the instance rather than
 * passed per call.
 */

import type {
  CheckItem,
  NewComment,
  PrDetail,
  PrFile,
  PrStatus,
  Reviewer,
  ReviewerState,
  ReviewThread,
  Viewer,
} from "../pr/types.ts";
import type {
  AzureChanges,
  AzureComment,
  AzureConnectionData,
  AzureIdentity,
  AzureItemContent,
  AzureIteration,
  AzureList,
  AzurePolicyEvaluation,
  AzurePullRequest,
  AzureReviewer,
  AzureThread,
} from "./apiTypes.ts";
import { buildPatch } from "./diff.ts";

type FetchFn = typeof fetch;

const API_VERSION = "7.1";
// policy/evaluations is exposed only under a preview version and 400s on the GA
// version, so that one call overrides the default.
const POLICY_API_VERSION = "7.1-preview.1";
// Code search is a separate service on its own host, still preview-only.
const SEARCH_API_VERSION = "7.1-preview.1";

// Azure comment/thread enum values used when posting a thread.
const COMMENT_TYPE_TEXT = 1;
const THREAD_STATUS_ACTIVE = 1;

// The PR's base/head commit pair is invariant for the life of an iteration, but
// every per-file diff needs it. Cache it briefly so opening an N-file PR doesn't
// re-fetch the PR once per file. Module-level because the client is constructed
// fresh per request; the short TTL bounds staleness to match the frontend cache.
const COMMIT_CACHE_TTL_MS = 60_000;
const commitCache = new Map<string, { base: string; head: string; ts: number }>();

// The authenticated user's identity GUID is invariant for a given PAT + org, but
// the client is constructed fresh per request, so resolving it via connectionData
// would repeat on every search. Cache it module-wide, keyed by org + token so a
// changed PAT or org URL is a new key and re-resolves on its own.
const viewerIdCache = new Map<string, string>();

const ALLOWED_AZURE_HOSTS = ["dev.azure.com", "visualstudio.com"];

/**
 * True when `orgUrl` is an https Azure DevOps organization URL. The PAT is sent
 * in the Authorization header on every request to this host, so an unvalidated
 * value would let a malformed/hostile URL exfiltrate the credential. GitHub's
 * client hardcodes its host; Azure's is user-supplied, so it is checked here.
 */
export function isAllowedAzureOrgUrl(orgUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(orgUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_AZURE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

/** Identity for one Azure DevOps pull request within the configured org. */
export interface AzureRef {
  project: string;
  repo: string;
  prId: number;
}

/** Azure-native PR summary (the frontend adapts this to the shared PrSummary). */
export interface AzurePrSummary {
  prId: number;
  title: string;
  url: string;
  org: string;
  project: string;
  repo: string;
  author: string;
  draft: boolean;
  status: string;
  createdAt: string;
}

/** Maps an Azure VersionControlChangeType onto GitHub's status vocabulary. */
function mapChangeType(changeType: string): string {
  const t = changeType.toLowerCase();
  if (t.includes("delete")) return "removed";
  if (t.includes("rename")) return "renamed";
  if (t.includes("add")) return "added";
  return "modified";
}

/** Maps an Azure mergeStatus onto the shared mergeable enum. */
function mapMergeStatus(mergeStatus: string | undefined): {
  mergeable: boolean | null;
  enum: MergeableEnum;
} {
  switch (mergeStatus) {
    case "succeeded":
      return { mergeable: true, enum: "MERGEABLE" };
    case "conflicts":
    case "rejectedByPolicy":
      return { mergeable: false, enum: "CONFLICTING" };
    default:
      return { mergeable: null, enum: "UNKNOWN" };
  }
}

/**
 * Maps an Azure reviewer vote onto the shared ReviewerState. Azure's vote
 * vocabulary is signed: 10 approved, 5 approved-with-suggestions, 0 no vote
 * yet, -5 waiting-for-author, -10 rejected. Both `-10` (rejected) and `-5`
 * (waiting-for-author) mean the reviewer is blocking the merge on the author
 * — collapsing them into `changes_requested` matches how GitHub renders the
 * equivalent state.
 */
function mapReviewerVote(vote: number | undefined): ReviewerState {
  switch (vote) {
    case 10:
    case 5:
      return "approved";
    case -10:
    case -5:
      return "changes_requested";
    default:
      return "pending";
  }
}

/**
 * Maps an Azure reviewer entry onto the shared Reviewer shape. Azure does not
 * have a login concept, so `displayName` (a human-readable name) is what fills
 * `login`; this matches how `PrDetail.author` handles the same conflation. A
 * zero/absent vote is Azure's closest analogue to GitHub's "review requested":
 * the reviewer is on the PR but hasn't weighed in yet.
 */
export function mapReviewer(reviewer: AzureReviewer): Reviewer {
  const vote = reviewer.vote ?? 0;
  return {
    login: reviewer.displayName ?? "",
    state: mapReviewerVote(vote),
    isRequested: vote === 0,
  };
}

/** Maps an Azure policy evaluation status onto the shared CheckItem shape. */
export function mapPolicyEvaluation(evaluation: AzurePolicyEvaluation): CheckItem | null {
  const status = String(evaluation.status ?? "");
  if (status === "notApplicable") return null;
  let conclusion: string | null = null;
  let normalized = "IN_PROGRESS";
  if (status === "approved") {
    normalized = "COMPLETED";
    conclusion = "SUCCESS";
  } else if (status === "rejected") {
    normalized = "COMPLETED";
    conclusion = "FAILURE";
  }
  return {
    name:
      evaluation.configuration?.type?.displayName ?? evaluation.configuration?.type?.id ?? "policy",
    status: normalized,
    conclusion,
    url: null,
  };
}

/** The shared mergeable vocabulary both providers map onto. */
export type MergeableEnum = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** A branch's active PR, shaped for the workspace poller's cache row. */
export interface AzureBranchPr {
  number: number;
  url: string;
  draft: boolean;
  /** Normalized to the poller's stored PR-state vocabulary. */
  state: "open" | "closed" | "merged";
  /** Azure mergeStatus mapped onto the shared mergeable enum. */
  mergeable: MergeableEnum;
}

/**
 * The organization name from a configured org URL. Modern URLs carry it as the
 * first path segment (`dev.azure.com/{org}`); legacy accounts carry it in the
 * subdomain (`{org}.visualstudio.com`). Deriving it the same way
 * `parseRepoRemote` derives a clone URL's org is what lets the poller's
 * cross-org comparison line up for both forms.
 */
export function orgFromOrgUrl(orgUrl: string): string {
  try {
    const url = new URL(orgUrl);
    if (url.hostname.endsWith(".visualstudio.com")) return url.hostname.split(".")[0] ?? "";
    return url.pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return orgUrl.split("/").filter(Boolean).pop() ?? "";
  }
}

export class AzureDevOpsClient {
  private readonly orgUrl: string;
  /** The configured organization (last segment of the org URL). Public so the
   *  poller can skip repos that live in a different org than this client. */
  readonly org: string;

  constructor(
    private readonly token: string,
    orgUrl: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {
    this.orgUrl = orgUrl.replace(/\/+$/, "");
    // Kept for display/cache identity the frontend echoes back, and for the
    // poller's cross-org skip — so it must match `parseRepoRemote`'s org.
    this.org = orgFromOrgUrl(this.orgUrl);
  }

  private authHeader(): string {
    return `Basic ${btoa(`:${this.token}`)}`;
  }

  private withVersion(url: string, version: string): string {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}api-version=${version}`;
  }

  // Most endpoints take the default api-version, but some need a specific preview
  // version (policy/evaluations) and a few legacy endpoints reject the param
  // entirely (connectionData). `apiVersion`: omit for the default, a string to
  // override it, or null to send no version param.
  private async get<T>(url: string, opts?: { apiVersion?: string | null }): Promise<T> {
    const apiVersion = opts?.apiVersion === undefined ? API_VERSION : opts.apiVersion;
    const requestUrl = apiVersion === null ? url : this.withVersion(url, apiVersion);
    const res = await this.fetchImpl(requestUrl, {
      headers: { Authorization: this.authHeader(), Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`azure GET ${url} -> ${res.status}`);
    return (await res.json()) as T;
  }

  /** File content at a commit, or "" when the file is absent on that side. */
  private async itemContent(repoBase: string, path: string, commit: string): Promise<string> {
    const url = `${repoBase}/items?path=${encodeURIComponent(path)}&versionDescriptor.version=${encodeURIComponent(
      commit,
    )}&versionDescriptor.versionType=commit&includeContent=true`;
    const res = await this.fetchImpl(this.withVersion(url, API_VERSION), {
      headers: { Authorization: this.authHeader(), Accept: "application/json" },
    });
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`azure GET items ${path} -> ${res.status}`);
    const item = (await res.json()) as AzureItemContent;
    return item.content ?? "";
  }

  private repoBase(ref: AzureRef): string {
    return `${this.orgUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(
      ref.repo,
    )}`;
  }

  /**
   * The authenticated user, resolved from the org-scoped connectionData endpoint.
   * This deliberately avoids the cross-org `app.vssps.visualstudio.com` profile
   * endpoint: an org-scoped PAT cannot authenticate there, and global PATs (the
   * only kind that can) are being retired.
   */
  private async authenticatedUser(): Promise<AzureIdentity> {
    // connectionData is a legacy location endpoint that 400s if sent an
    // api-version, so it is requested unversioned (matching Microsoft's SDK).
    const data = await this.get<AzureConnectionData>(`${this.orgUrl}/_apis/connectionData`, {
      apiVersion: null,
    });
    const user = data.authenticatedUser;
    if (!user?.id) throw new Error("azure connectionData returned no authenticated user");
    return user;
  }

  // Newlines can't appear in either part, so they can't collide across keys.
  private viewerCacheKey(): string {
    return `${this.orgUrl}\n${this.token}`;
  }

  private async resolveViewerId(): Promise<string> {
    const key = this.viewerCacheKey();
    const cached = viewerIdCache.get(key);
    if (cached) return cached;
    const user = await this.authenticatedUser();
    viewerIdCache.set(key, user.id);
    return user.id;
  }

  async viewer(): Promise<Viewer> {
    // Always a live call: this is the gate that verifies the PAT still works. It
    // also warms the id cache so a search in the same page load skips a round trip.
    const user = await this.authenticatedUser();
    viewerIdCache.set(this.viewerCacheKey(), user.id);
    return { login: user.providerDisplayName ?? "", id: user.id };
  }

  /**
   * Active PRs scoped to the current user. `scope` is "mine" (created by me) or
   * "review" (I'm a reviewer); `project` optionally narrows to one project.
   */
  async search(scope: string, project?: string): Promise<AzurePrSummary[]> {
    const id = await this.resolveViewerId();
    const criterion =
      scope === "review" ? `searchCriteria.reviewerId=${id}` : `searchCriteria.creatorId=${id}`;
    const base = project
      ? `${this.orgUrl}/${encodeURIComponent(project)}/_apis/git/pullrequests`
      : `${this.orgUrl}/_apis/git/pullrequests`;
    const data = await this.get<AzureList<AzurePullRequest>>(
      `${base}?searchCriteria.status=active&${criterion}&$top=50`,
    );
    return (data.value ?? []).map((pr) => this.toSummary(pr));
  }

  /**
   * The most recent PR whose source branch is `branch` in the given
   * project/repo, or null. Used by the workspace poller to auto-detect a
   * worktree branch's PR. `status=all` mirrors the GitHub client so a
   * merged/abandoned PR still resolves; Azure returns newest first, so `$top=1`
   * picks the latest.
   */
  async findPrByBranch(
    project: string,
    repo: string,
    branch: string,
  ): Promise<AzureBranchPr | null> {
    const base = `${this.orgUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(
      repo,
    )}/pullrequests`;
    const sourceRef = encodeURIComponent(`refs/heads/${branch}`);
    const data = await this.get<AzureList<AzurePullRequest>>(
      `${base}?searchCriteria.sourceRefName=${sourceRef}&searchCriteria.status=all&$top=1`,
    );
    const pr = data.value?.[0];
    if (!pr) return null;
    return {
      number: pr.pullRequestId,
      url: this.prWebUrl(pr),
      draft: Boolean(pr.isDraft),
      state: pr.status === "completed" ? "merged" : pr.status === "abandoned" ? "closed" : "open",
      mergeable: mapMergeStatus(pr.mergeStatus).enum,
    };
  }

  /** The PR's web (browser) URL, from the repo's `webUrl` when present or
   *  reconstructed from the org/project/repo otherwise. */
  private prWebUrl(pr: AzurePullRequest): string {
    const project = pr.repository?.project?.name ?? "";
    const repo = pr.repository?.name ?? "";
    return pr.repository?.webUrl
      ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`
      : `${this.orgUrl}/${project}/_git/${repo}/pullrequest/${pr.pullRequestId}`;
  }

  private toSummary(pr: AzurePullRequest): AzurePrSummary {
    return {
      prId: pr.pullRequestId,
      title: pr.title ?? "",
      url: this.prWebUrl(pr),
      org: this.org,
      project: pr.repository?.project?.name ?? "",
      repo: pr.repository?.name ?? "",
      author: pr.createdBy?.displayName ?? "",
      draft: Boolean(pr.isDraft),
      status: pr.status ?? "active",
      createdAt: pr.creationDate ?? "",
    };
  }

  private async prRaw(ref: AzureRef): Promise<AzurePullRequest> {
    return this.get<AzurePullRequest>(`${this.repoBase(ref)}/pullRequests/${ref.prId}`);
  }

  /** The PR's base/head commit ids, cached briefly to avoid a fetch per file. */
  private async commitPair(ref: AzureRef): Promise<{ base?: string; head?: string }> {
    const key = `${this.org}/${ref.project}/${ref.repo}/${ref.prId}`;
    const cached = commitCache.get(key);
    if (cached && Date.now() - cached.ts < COMMIT_CACHE_TTL_MS) {
      return { base: cached.base, head: cached.head };
    }
    const pr = await this.prRaw(ref);
    const head = pr.lastMergeSourceCommit?.commitId;
    const base = pr.lastMergeTargetCommit?.commitId;
    if (base && head) commitCache.set(key, { base, head, ts: Date.now() });
    return { base, head };
  }

  /** Lightweight per-row status: one call, no policy evaluations. */
  async prStatus(ref: AzureRef): Promise<PrStatus> {
    const pr = await this.prRaw(ref);
    const merge = mapMergeStatus(pr.mergeStatus);
    return {
      state: pr.status ?? "active",
      merged: pr.status === "completed",
      mergeable: merge.mergeable,
      mergeableState: pr.mergeStatus ?? "unknown",
      checks: { total: 0, success: 0, failure: 0, pending: 0 },
    };
  }

  async prDetail(ref: AzureRef): Promise<PrDetail> {
    const pr = await this.prRaw(ref);
    const projectId = pr.repository?.project?.id ?? "";
    const [checks, reviewThreads] = await Promise.all([
      this.checks(ref.project, projectId, ref.prId),
      this.threads(ref),
    ]);
    return {
      number: pr.pullRequestId,
      title: pr.title ?? "",
      body: pr.description ?? "",
      state: pr.status ?? "active",
      draft: Boolean(pr.isDraft),
      author: pr.createdBy?.displayName ?? "",
      baseRef: (pr.targetRefName ?? "").replace("refs/heads/", ""),
      headRef: (pr.sourceRefName ?? "").replace("refs/heads/", ""),
      headSha: pr.lastMergeSourceCommit?.commitId ?? "",
      additions: 0,
      deletions: 0,
      mergeable: mapMergeStatus(pr.mergeStatus).enum,
      // Azure's completion/auto-complete flow isn't wired to the review UI yet,
      // so the merge controls stay hidden for Azure PRs.
      mergeMethods: [],
      autoMergeEnabled: false,
      canEnableAutoMerge: false,
      canDisableAutoMerge: false,
      checks,
      reviewThreads,
      reviewers: (pr.reviewers ?? []).map(mapReviewer).filter((r) => r.login),
    };
  }

  private async checks(project: string, projectId: string, prId: number): Promise<CheckItem[]> {
    if (!projectId) return [];
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await this.get<AzureList<AzurePolicyEvaluation>>(
      `${this.orgUrl}/${encodeURIComponent(project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(
        artifactId,
      )}`,
      { apiVersion: POLICY_API_VERSION },
    );
    return (data.value ?? []).map(mapPolicyEvaluation).filter((c): c is CheckItem => c !== null);
  }

  private async threads(ref: AzureRef): Promise<ReviewThread[]> {
    const data = await this.get<AzureList<AzureThread>>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/threads`,
    );
    return (data.value ?? [])
      .map((thread) => this.toThread(thread))
      .filter((t): t is ReviewThread => t !== null);
  }

  private toThread(thread: AzureThread): ReviewThread | null {
    const comments = (thread.comments ?? []).filter(
      (c: AzureComment) => c.commentType !== "system",
    );
    if (comments.length === 0) return null;
    const ctx = thread.threadContext;
    const path = ctx?.filePath ? ctx.filePath.replace(/^\//, "") : null;
    const line = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line ?? null;
    return {
      path,
      line,
      isResolved: thread.status === "closed" || thread.status === "fixed",
      comments: comments.map((c) => ({
        author: c.author?.displayName ?? "",
        body: c.content ?? "",
        createdAt: c.publishedDate ?? "",
      })),
    };
  }

  /**
   * The changed-file list (no patches). Diffs are loaded per file via
   * `prFileDiff` so a large PR does not fetch every file's content up front.
   */
  async prFiles(ref: AzureRef): Promise<PrFile[]> {
    const iterations = await this.get<AzureList<AzureIteration>>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/iterations`,
    );
    const last = (iterations.value ?? []).at(-1);
    if (!last) return [];
    const changes = await this.get<AzureChanges>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/iterations/${last.id}/changes`,
    );
    return (changes.changeEntries ?? [])
      .filter((e) => e.item?.path && !e.item?.isFolder)
      .map((e) => ({
        filename: (e.item?.path ?? "").replace(/^\//, ""),
        status: mapChangeType(e.changeType ?? "edit"),
        additions: 0,
        deletions: 0,
        patch: null,
      }));
  }

  /**
   * A file's full text at a commit, for showing the unchanged code around a
   * hunk. A missing path resolves to empty, matching how the diff builder
   * already treats a file that exists on only one side of the change.
   */
  fileContent(ref: AzureRef, path: string, commit: string): Promise<string> {
    return this.itemContent(this.repoBase(ref), `/${path.replace(/^\//, "")}`, commit);
  }

  /**
   * Entries directly under a directory at a commit. Azure returns the directory
   * itself as the first entry of the listing, so it is filtered back out.
   */
  async listDir(
    ref: AzureRef,
    path: string,
    commit: string,
  ): Promise<{ path: string; type: string }[]> {
    const scope = `/${path.replace(/^\/+|\/+$/g, "")}`;
    const url =
      `${this.repoBase(ref)}/items?scopePath=${encodeURIComponent(scope)}` +
      `&recursionLevel=OneLevel&versionDescriptor.version=${encodeURIComponent(commit)}` +
      `&versionDescriptor.versionType=commit`;
    const res = await this.fetchImpl(this.withVersion(url, API_VERSION), {
      headers: { Authorization: this.authHeader(), Accept: "application/json" },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`azure GET items ${scope} -> ${res.status}`);
    const body = (await res.json()) as { value?: { path?: string; isFolder?: boolean }[] };
    return (body.value ?? [])
      .filter((item) => item.path && item.path !== scope)
      .map((item) => ({
        path: (item.path ?? "").replace(/^\//, ""),
        type: item.isFolder ? "dir" : "file",
      }));
  }

  /**
   * Repo-scoped code search.
   *
   * This is the only call that leaves `dev.azure.com` — code search lives on a
   * separate `almsearch` host and is provided by an extension that an
   * organization may simply not have installed. Rather than failing the whole
   * agent run over a capability that is optional by design, an unavailable
   * search resolves to null and the caller reports it as such.
   */
  async searchCode(ref: AzureRef, query: string, limit = 10): Promise<{ path: string }[] | null> {
    const host = this.orgUrl.replace("https://dev.azure.com", "https://almsearch.dev.azure.com");
    const url = this.withVersion(
      `${host}/${encodeURIComponent(ref.project)}/_apis/search/codesearchresults`,
      SEARCH_API_VERSION,
    );
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        searchText: query,
        $top: limit,
        filters: { Repository: [ref.repo] },
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: { path?: string }[] };
    // Azure reports matches as character offsets into the file rather than as
    // text, so there is no snippet to hand back without fetching each hit —
    // paths only, and the caller reads the ones it cares about.
    return (body.results ?? []).map((hit) => ({
      path: (hit.path ?? "").replace(/^\//, ""),
    }));
  }

  /** Builds one file's unified diff between the PR's base and head commits. */
  async prFileDiff(ref: AzureRef, path: string): Promise<PrFile> {
    const { base, head } = await this.commitPair(ref);
    const filename = path.replace(/^\//, "");
    if (!head || !base) {
      return { filename, status: "modified", additions: 0, deletions: 0, patch: null };
    }
    const repoBase = this.repoBase(ref);
    const [baseContent, headContent] = await Promise.all([
      this.itemContent(repoBase, `/${filename}`, base),
      this.itemContent(repoBase, `/${filename}`, head),
    ]);
    const built = buildPatch(filename, baseContent, headContent);
    const status = baseContent === "" ? "added" : headContent === "" ? "removed" : "modified";
    return {
      filename,
      status,
      additions: built.additions,
      deletions: built.deletions,
      patch: built.patch,
    };
  }

  /**
   * Publishes a draft PR (Azure equivalent of GitHub's "Ready for review"):
   * clears the `isDraft` flag with a PATCH on the PR itself.
   */
  async markReady(ref: AzureRef): Promise<void> {
    const url = this.withVersion(`${this.repoBase(ref)}/pullRequests/${ref.prId}`, API_VERSION);
    const res = await this.fetchImpl(url, {
      method: "PATCH",
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isDraft: false }),
    });
    if (!res.ok) throw new Error(`azure mark ready -> ${res.status}`);
  }

  /**
   * Casts the viewer's vote on the PR (Azure's equivalent of approve / request
   * changes). The vote vocabulary is numeric:
   *   10  approved
   *    5  approved with suggestions
   *    0  no vote (resets)
   *   -5  waiting for author
   *  -10  rejected
   * Azure has no "review body" tied to a vote, so when `body` is supplied we
   * additionally post a regular PR-level comment thread so the user's note
   * isn't lost. That extra thread is best-effort — if it fails after the vote
   * succeeded, the vote still stands.
   */
  async submitVote(ref: AzureRef, vote: number, body?: string): Promise<void> {
    const reviewerId = await this.resolveViewerId();
    const voteUrl = this.withVersion(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/reviewers/${reviewerId}`,
      API_VERSION,
    );
    const res = await this.fetchImpl(voteUrl, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ vote, id: reviewerId }),
    });
    if (!res.ok) throw new Error(`azure submit vote -> ${res.status}`);

    if (body && body.trim().length > 0) {
      await this.postPrComment(ref, body);
    }
  }

  /**
   * Posts a PR-level comment thread (no file/line anchor). Used for the review
   * body that accompanies an approve / request-changes vote, since Azure does
   * not attach a body to the vote itself.
   */
  private async postPrComment(ref: AzureRef, body: string): Promise<void> {
    const url = this.withVersion(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/threads`,
      API_VERSION,
    );
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        comments: [{ content: body, commentType: COMMENT_TYPE_TEXT }],
        status: THREAD_STATUS_ACTIVE,
      }),
    });
    if (!res.ok) throw new Error(`azure post pr comment -> ${res.status}`);
  }

  /** Posts a single-line comment thread anchored to the right side of the diff. */
  async postComment(ref: AzureRef, input: NewComment): Promise<void> {
    const body = {
      comments: [{ content: input.body, commentType: COMMENT_TYPE_TEXT }],
      status: THREAD_STATUS_ACTIVE,
      threadContext: {
        filePath: `/${input.path.replace(/^\//, "")}`,
        rightFileStart: { line: input.line, offset: 1 },
        rightFileEnd: { line: input.line, offset: 1 },
      },
    };
    const res = await this.fetchImpl(
      this.withVersion(`${this.repoBase(ref)}/pullRequests/${ref.prId}/threads`, API_VERSION),
      {
        method: "POST",
        headers: {
          Authorization: this.authHeader(),
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`azure post comment -> ${res.status}`);
  }
}
