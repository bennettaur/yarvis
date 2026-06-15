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
  ReviewThread,
  Viewer,
} from "../pr/types.ts";
import type {
  AzureChanges,
  AzureComment,
  AzureItemContent,
  AzureIteration,
  AzureList,
  AzurePolicyEvaluation,
  AzureProfile,
  AzurePullRequest,
  AzureThread,
} from "./apiTypes.ts";
import { buildPatch } from "./diff.ts";

type FetchFn = typeof fetch;

const API_VERSION = "7.1";

// Azure comment/thread enum values used when posting a thread.
const COMMENT_TYPE_TEXT = 1;
const THREAD_STATUS_ACTIVE = 1;

// The PR's base/head commit pair is invariant for the life of an iteration, but
// every per-file diff needs it. Cache it briefly so opening an N-file PR doesn't
// re-fetch the PR once per file. Module-level because the client is constructed
// fresh per request; the short TTL bounds staleness to match the frontend cache.
const COMMIT_CACHE_TTL_MS = 60_000;
const commitCache = new Map<string, { base: string; head: string; ts: number }>();

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
  enum: string;
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

export class AzureDevOpsClient {
  private readonly orgUrl: string;
  private readonly org: string;
  private viewerId: string | null = null;

  constructor(
    private readonly token: string,
    orgUrl: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {
    this.orgUrl = orgUrl.replace(/\/+$/, "");
    // Last path segment of https://dev.azure.com/<org> is the org name; kept for
    // display/cache identity the frontend echoes back.
    this.org = this.orgUrl.split("/").filter(Boolean).pop() ?? "";
  }

  private authHeader(): string {
    return `Basic ${btoa(`:${this.token}`)}`;
  }

  private withVersion(url: string): string {
    return url.includes("?")
      ? `${url}&api-version=${API_VERSION}`
      : `${url}?api-version=${API_VERSION}`;
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(this.withVersion(url), {
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
    const res = await this.fetchImpl(this.withVersion(url), {
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

  private async resolveViewerId(): Promise<string> {
    if (this.viewerId) return this.viewerId;
    const profile = await this.get<AzureProfile>(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me",
    );
    this.viewerId = profile.id;
    return profile.id;
  }

  async viewer(): Promise<Viewer> {
    const profile = await this.get<AzureProfile>(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me",
    );
    this.viewerId = profile.id;
    return { login: profile.displayName ?? "", id: profile.id };
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

  private toSummary(pr: AzurePullRequest): AzurePrSummary {
    const project = pr.repository?.project?.name ?? "";
    const repo = pr.repository?.name ?? "";
    const webUrl = pr.repository?.webUrl
      ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}`
      : `${this.orgUrl}/${project}/_git/${repo}/pullrequest/${pr.pullRequestId}`;
    return {
      prId: pr.pullRequestId,
      title: pr.title ?? "",
      url: webUrl,
      org: this.org,
      project,
      repo,
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
      additions: 0,
      deletions: 0,
      mergeable: mapMergeStatus(pr.mergeStatus).enum,
      checks,
      reviewThreads,
    };
  }

  private async checks(project: string, projectId: string, prId: number): Promise<CheckItem[]> {
    if (!projectId) return [];
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await this.get<AzureList<AzurePolicyEvaluation>>(
      `${this.orgUrl}/${encodeURIComponent(project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(
        artifactId,
      )}`,
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
      this.withVersion(`${this.repoBase(ref)}/pullRequests/${ref.prId}/threads`),
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
