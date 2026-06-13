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
import { buildPatch } from "./diff.ts";

type FetchFn = typeof fetch;

const API_VERSION = "7.1";

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
export function mapPolicyEvaluation(evaluation: any): CheckItem | null {
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
    const item = (await res.json()) as { content?: string };
    return item.content ?? "";
  }

  private repoBase(ref: AzureRef): string {
    return `${this.orgUrl}/${encodeURIComponent(ref.project)}/_apis/git/repositories/${encodeURIComponent(
      ref.repo,
    )}`;
  }

  private async resolveViewerId(): Promise<string> {
    if (this.viewerId) return this.viewerId;
    const profile = await this.get<{ id: string }>(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me",
    );
    this.viewerId = profile.id;
    return profile.id;
  }

  async viewer(): Promise<Viewer> {
    const profile = await this.get<{ id: string; displayName: string }>(
      "https://app.vssps.visualstudio.com/_apis/profile/profiles/me",
    );
    this.viewerId = profile.id;
    return { login: profile.displayName, id: profile.id };
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
    const data = await this.get<{ value?: any[] }>(
      `${base}?searchCriteria.status=active&${criterion}&$top=50`,
    );
    return (data.value ?? []).map((pr) => this.toSummary(pr));
  }

  private toSummary(pr: any): AzurePrSummary {
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

  private async prRaw(ref: AzureRef): Promise<any> {
    return this.get<any>(`${this.repoBase(ref)}/pullRequests/${ref.prId}`);
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
    const data = await this.get<{ value?: any[] }>(
      `${this.orgUrl}/${encodeURIComponent(project)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(
        artifactId,
      )}`,
    );
    return (data.value ?? []).map(mapPolicyEvaluation).filter((c): c is CheckItem => c !== null);
  }

  private async threads(ref: AzureRef): Promise<ReviewThread[]> {
    const data = await this.get<{ value?: any[] }>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/threads`,
    );
    return (data.value ?? [])
      .map((thread) => this.toThread(thread))
      .filter((t): t is ReviewThread => t !== null);
  }

  private toThread(thread: any): ReviewThread | null {
    const comments = (thread.comments ?? []).filter((c: any) => c.commentType !== "system");
    if (comments.length === 0) return null;
    const ctx = thread.threadContext;
    const path = ctx?.filePath ? String(ctx.filePath).replace(/^\//, "") : null;
    const line = ctx?.rightFileStart?.line ?? ctx?.leftFileStart?.line ?? null;
    return {
      path,
      line,
      isResolved: thread.status === "closed" || thread.status === "fixed",
      comments: comments.map((c: any) => ({
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
    const iterations = await this.get<{ value?: any[] }>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/iterations`,
    );
    const last = (iterations.value ?? []).at(-1);
    if (!last) return [];
    const changes = await this.get<{ changeEntries?: any[] }>(
      `${this.repoBase(ref)}/pullRequests/${ref.prId}/iterations/${last.id}/changes`,
    );
    return (changes.changeEntries ?? [])
      .filter((e) => e.item?.path && !e.item?.isFolder)
      .map((e) => ({
        filename: String(e.item.path).replace(/^\//, ""),
        status: mapChangeType(e.changeType ?? "edit"),
        additions: 0,
        deletions: 0,
        patch: null,
      }));
  }

  /** Builds one file's unified diff between the PR's base and head commits. */
  async prFileDiff(ref: AzureRef, path: string): Promise<PrFile> {
    const pr = await this.prRaw(ref);
    const head = pr.lastMergeSourceCommit?.commitId;
    const base = pr.lastMergeTargetCommit?.commitId;
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
      comments: [{ content: input.body, commentType: 1 }],
      status: 1,
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
