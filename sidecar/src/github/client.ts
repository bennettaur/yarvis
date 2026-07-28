/**
 * Minimal GitHub REST client over fetch (no SDK dependency). The fetch
 * implementation is injectable so response shaping can be unit-tested.
 */

import type { IssueDetail, IssueLabel, IssueSummary } from "../issues/types.ts";
import type {
  CheckItem,
  ChecksSummary,
  MergeMethod,
  NewComment,
  PrDetail,
  PrFile,
  PrStatus,
  PrSummary,
} from "../pr/types.ts";

// Re-exported so existing `from "./client.ts"` imports keep resolving the
// provider-neutral shapes that now live in ../pr/types.ts.
export type {
  CheckItem,
  ChecksSummary,
  MergeMethod,
  NewComment,
  PrDetail,
  PrFile,
  PrStatus,
  PrSummary,
  ReviewComment,
  ReviewThread,
} from "../pr/types.ts";

type FetchFn = typeof fetch;

function parseRepo(repositoryUrl?: string, htmlUrl?: string): { owner: string; repo: string } {
  if (repositoryUrl) {
    const m = repositoryUrl.match(/repos\/([^/]+)\/([^/]+)$/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  if (htmlUrl) {
    const m = htmlUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return { owner: "", repo: "" };
}

export function toPrSummary(item: any): PrSummary {
  const { owner, repo } = parseRepo(item.repository_url, item.html_url);
  return {
    number: item.number,
    title: item.title,
    url: item.html_url,
    owner,
    repo,
    author: item.user?.login ?? "",
    draft: Boolean(item.draft),
    state: item.state,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

/** Extracts {owner, repo} from an issue's repository_url or html_url. Mirrors
 * `parseRepo` above for the issue URL shape (`/issues` rather than `/pull`). */
function parseIssueRepo(repositoryUrl?: string, htmlUrl?: string): { owner: string; repo: string } {
  if (repositoryUrl) {
    const m = repositoryUrl.match(/repos\/([^/]+)\/([^/]+)$/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  if (htmlUrl) {
    const m = htmlUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues/);
    if (m) return { owner: m[1]!, repo: m[2]! };
  }
  return { owner: "", repo: "" };
}

function toIssueLabels(raw: any[]): IssueLabel[] {
  return (raw ?? []).map((l) =>
    // Labels come back as strings on some legacy payloads, objects otherwise.
    typeof l === "string"
      ? { name: l, color: null }
      : { name: l.name ?? "", color: l.color ?? null },
  );
}

/**
 * Shapes a GitHub issue (REST or Search item) into a provider-neutral
 * IssueSummary. `fallback` supplies owner/repo for endpoints that don't echo a
 * repository_url (the single-issue REST route), where the caller already knows
 * the repo.
 */
export function toIssueSummary(
  item: any,
  fallback?: { owner: string; repo: string },
): IssueSummary {
  const parsed = parseIssueRepo(item.repository_url, item.html_url);
  const owner = parsed.owner || fallback?.owner || "";
  const repo = parsed.repo || fallback?.repo || "";
  const sourceKey = `${owner}/${repo}`;
  return {
    provider: "github",
    sourceKey,
    sourceLabel: sourceKey,
    externalId: String(item.number),
    displayId: `#${item.number}`,
    title: item.title ?? "",
    url: item.html_url ?? "",
    state: item.state ?? "open",
    author: item.user?.login ?? "",
    assignees: (item.assignees ?? []).map((a: any) => a.login).filter(Boolean),
    labels: toIssueLabels(item.labels),
    createdAt: item.created_at ?? "",
    updatedAt: item.updated_at ?? "",
    commentCount: item.comments ?? 0,
  };
}

/** Shapes an issue plus its comments into a full IssueDetail. */
export function toIssueDetail(
  item: any,
  comments: any[],
  fallback?: { owner: string; repo: string },
): IssueDetail {
  return {
    ...toIssueSummary(item, fallback),
    body: item.body ?? "",
    comments: (comments ?? []).map((c) => ({
      author: c.user?.login ?? "",
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
    })),
  };
}

export function summarizeChecks(runs: any[]): ChecksSummary {
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const r of runs) {
    if (r.status !== "completed") {
      pending++;
    } else if (["success", "neutral", "skipped"].includes(r.conclusion)) {
      success++;
    } else {
      failure++;
    }
  }
  return { total: runs.length, success, failure, pending };
}

/** Normalizes a GraphQL statusCheckRollup context into a flat CheckItem. */
function toCheckItem(node: any): CheckItem {
  if (node.__typename === "CheckRun") {
    return {
      name: node.name ?? "check",
      status: node.status ?? "COMPLETED",
      conclusion: node.conclusion ?? null,
      url: node.detailsUrl ?? null,
    };
  }
  // StatusContext (legacy commit status): map its state onto the same shape.
  return {
    name: node.context ?? "status",
    status: "COMPLETED",
    conclusion: node.state ?? null,
    url: node.targetUrl ?? null,
  };
}

/**
 * The repo-level merge settings that gate which strategies the merge / auto-merge
 * UI may offer. Read off the `repository` node alongside the pull request.
 */
function allowedMergeMethods(repo: any): MergeMethod[] {
  const methods: MergeMethod[] = [];
  if (repo?.mergeCommitAllowed) methods.push("MERGE");
  if (repo?.squashMergeAllowed) methods.push("SQUASH");
  if (repo?.rebaseMergeAllowed) methods.push("REBASE");
  return methods;
}

/**
 * Shapes the GraphQL `pullRequest` payload into a flat PrDetail. `repo` carries
 * the sibling `repository` node whose merge-method flags the UI needs; it's
 * optional so unit tests can shape a PR without it (merge buttons stay hidden).
 */
export function toPrDetail(pr: any, repo?: any): PrDetail {
  const rollupNodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const threadNodes = pr.reviewThreads?.nodes ?? [];
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    state: pr.state,
    draft: Boolean(pr.isDraft),
    author: pr.author?.login ?? "",
    baseRef: pr.baseRefName ?? "",
    headRef: pr.headRefName ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    mergeable: pr.mergeable ?? "UNKNOWN",
    mergeMethods: allowedMergeMethods(repo),
    autoMergeEnabled: Boolean(pr.autoMergeRequest),
    canEnableAutoMerge: Boolean(pr.viewerCanEnableAutoMerge),
    canDisableAutoMerge: Boolean(pr.viewerCanDisableAutoMerge),
    checks: rollupNodes.map(toCheckItem),
    reviewThreads: threadNodes.map((thread: any) => ({
      path: thread.path ?? null,
      line: thread.line ?? null,
      isResolved: Boolean(thread.isResolved),
      comments: (thread.comments?.nodes ?? []).map((comment: any) => ({
        author: comment.author?.login ?? "",
        body: comment.body ?? "",
        createdAt: comment.createdAt ?? "",
      })),
    })),
  };
}

const PR_DETAIL_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number:$number){
      number title body state isDraft additions deletions mergeable
      autoMergeRequest{ enabledAt }
      viewerCanEnableAutoMerge viewerCanDisableAutoMerge
      author{login}
      baseRefName headRefName
      reviewThreads(first:50){
        nodes{
          isResolved path line
          comments(first:50){ nodes{ author{login} body createdAt } }
        }
      }
      commits(last:1){
        nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        }}}}}
      }
    }
  }
}`;

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`github ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`github graphql -> ${res.status}`);
    const payload = (await res.json()) as { data?: T; errors?: unknown };
    if (payload.errors) {
      throw new Error(`github graphql: ${JSON.stringify(payload.errors)}`);
    }
    return payload.data as T;
  }

  viewer(): Promise<{ login: string }> {
    return this.api<{ login: string }>("/user");
  }

  async search(query: string): Promise<PrSummary[]> {
    const data = await this.api<{ items?: any[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=created&order=desc`,
    );
    return (data.items ?? []).filter((i) => i.pull_request).map(toPrSummary);
  }

  async prStatus(owner: string, repo: string, number: number): Promise<PrStatus> {
    const pr = await this.api<any>(`/repos/${owner}/${repo}/pulls/${number}`);
    const checks = await this.api<{ check_runs?: any[] }>(
      `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
    );
    return {
      state: pr.state ?? "open",
      merged: Boolean(pr.merged),
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? "unknown",
      checks: summarizeChecks(checks.check_runs ?? []),
    };
  }

  /**
   * Finds the most recent PR whose head branch is `branch` in the given repo,
   * or null. Uses the core REST `pulls?head=` filter (not the Search API, whose
   * tight secondary rate limit the background poller would otherwise hit).
   */
  async findPrByBranch(owner: string, repo: string, branch: string): Promise<PrSummary | null> {
    const head = encodeURIComponent(`${owner}:${branch}`);
    const items = await this.api<any[]>(
      `/repos/${owner}/${repo}/pulls?head=${head}&state=all&sort=created&direction=desc&per_page=1`,
    );
    const item = items[0];
    return item ? toPrSummary(item) : null;
  }

  async prDetail(owner: string, repo: string, number: number): Promise<PrDetail> {
    const data = await this.graphql<{
      repository?: { pullRequest?: any };
    }>(PR_DETAIL_QUERY, { owner, repo, number });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error(`pull request ${owner}/${repo}#${number} not found`);
    return toPrDetail(pr, data.repository);
  }

  async prFiles(owner: string, repo: string, number: number): Promise<PrFile[]> {
    const files = await this.api<any[]>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`,
    );
    return files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch ?? null,
    }));
  }

  /**
   * Marks a draft pull request as ready for review (the GraphQL equivalent of
   * the "Ready for review" button). GitHub keys this mutation by the PR's node
   * id, not its number, so a tiny preflight resolves the id first.
   */
  async markReady(owner: string, repo: string, number: number): Promise<void> {
    const id = await this.resolvePrNodeId(owner, repo, number);
    await this.graphql<unknown>(
      `mutation($id:ID!){
        markPullRequestReadyForReview(input:{pullRequestId:$id}){ clientMutationId }
      }`,
      { id },
    );
  }

  /**
   * Merges the pull request now with the chosen strategy (the GraphQL
   * equivalent of the green "Merge" button). Keyed by the PR's node id, so a
   * preflight resolves it first. GitHub rejects a method the repo disallows or
   * a PR that isn't currently mergeable; the error is surfaced to the caller.
   */
  async mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    const id = await this.resolvePrNodeId(owner, repo, number);
    await this.graphql<unknown>(
      `mutation($id:ID!,$method:PullRequestMergeMethod!){
        mergePullRequest(input:{pullRequestId:$id, mergeMethod:$method}){ clientMutationId }
      }`,
      { id, method },
    );
  }

  /**
   * Arms auto-merge: GitHub merges the PR automatically once its branch
   * protections pass. Requires the repo to allow auto-merge and the chosen
   * method; GitHub rejects otherwise.
   */
  async enableAutoMerge(
    owner: string,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    const id = await this.resolvePrNodeId(owner, repo, number);
    await this.graphql<unknown>(
      `mutation($id:ID!,$method:PullRequestMergeMethod!){
        enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:$method}){ clientMutationId }
      }`,
      { id, method },
    );
  }

  /** Cancels a pending auto-merge so the PR won't merge on its own. */
  async disableAutoMerge(owner: string, repo: string, number: number): Promise<void> {
    const id = await this.resolvePrNodeId(owner, repo, number);
    await this.graphql<unknown>(
      `mutation($id:ID!){
        disablePullRequestAutoMerge(input:{pullRequestId:$id}){ clientMutationId }
      }`,
      { id },
    );
  }

  private async resolvePrNodeId(owner: string, repo: string, number: number): Promise<string> {
    const data = await this.graphql<{ repository?: { pullRequest?: { id: string } } }>(
      `query($owner:String!,$repo:String!,$number:Int!){
        repository(owner:$owner,name:$repo){ pullRequest(number:$number){ id } }
      }`,
      { owner, repo, number },
    );
    const id = data.repository?.pullRequest?.id;
    if (!id) throw new Error(`pull request ${owner}/${repo}#${number} not found`);
    return id;
  }

  /**
   * Paths of changed files the viewer has marked viewed on this PR. Uses
   * GraphQL pagination because the REST files endpoint doesn't carry the
   * `viewerViewedState` field. Capped at 100 per page; loops on pageInfo.
   */
  async listViewedFiles(owner: string, repo: string, number: number): Promise<string[]> {
    interface ViewedPage {
      repository?: {
        pullRequest?: {
          files?: {
            nodes?: Array<{ path: string; viewerViewedState: string }>;
            pageInfo?: { hasNextPage: boolean; endCursor: string };
          };
        };
      };
    }
    const viewed: string[] = [];
    let cursor: string | null = null;
    do {
      const data: ViewedPage = await this.graphql<ViewedPage>(
        `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$number){
              files(first:100, after:$cursor){
                nodes{ path viewerViewedState }
                pageInfo{ hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner, repo, number, cursor },
      );
      const page = data.repository?.pullRequest?.files;
      for (const n of page?.nodes ?? []) {
        if (n.viewerViewedState === "VIEWED") viewed.push(n.path);
      }
      cursor = page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null;
    } while (cursor);
    return viewed;
  }

  /** Sets (or clears) the viewer's "viewed" flag on a single PR file. */
  async setFileViewed(
    owner: string,
    repo: string,
    number: number,
    path: string,
    viewed: boolean,
  ): Promise<void> {
    const id = await this.resolvePrNodeId(owner, repo, number);
    const mutation = viewed
      ? `mutation($id:ID!,$path:String!){
          markFileAsViewed(input:{pullRequestId:$id, path:$path}){ clientMutationId }
        }`
      : `mutation($id:ID!,$path:String!){
          unmarkFileAsViewed(input:{pullRequestId:$id, path:$path}){ clientMutationId }
        }`;
    await this.graphql<unknown>(mutation, { id, path });
  }

  /**
   * Submits a PR review. `event` is GitHub's verb: APPROVE accepts the PR,
   * REQUEST_CHANGES blocks it, COMMENT leaves an unbinding comment. The body
   * is optional (GitHub allows a bodyless approval but requires text on a
   * request-changes review; the caller is expected to enforce that).
   */
  async submitReview(
    owner: string,
    repo: string,
    number: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string,
  ): Promise<void> {
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ event, body: body ?? "" }),
      },
    );
    if (!res.ok) throw new Error(`github submit review -> ${res.status}`);
  }

  /**
   * Posts a single-line review comment. GitHub anchors review comments to a
   * commit, so the PR's head sha is fetched first; `line` + `side` target the
   * line in the diff (the same right-side line our diff parser exposes).
   */
  async postComment(owner: string, repo: string, number: number, input: NewComment): Promise<void> {
    const pr = await this.api<{ head: { sha: string } }>(`/repos/${owner}/${repo}/pulls/${number}`);
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/comments`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: input.body,
          commit_id: pr.head.sha,
          path: input.path,
          line: input.line,
          side: input.side ?? "RIGHT",
        }),
      },
    );
    if (!res.ok) throw new Error(`github post comment -> ${res.status}`);
  }

  // --- Issues ---

  /**
   * Runs a GitHub issue search and drops pull requests. The `/search/issues`
   * endpoint returns both issues and PRs (a PR *is* an issue to GitHub); a PR
   * carries a `pull_request` field, so the absence of it identifies a true
   * issue — the mirror of what `search()` does for PRs.
   */
  async searchIssues(query: string): Promise<IssueSummary[]> {
    const data = await this.api<{ items?: any[] }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=50&sort=created&order=desc`,
    );
    return (data.items ?? []).filter((i) => !i.pull_request).map((i) => toIssueSummary(i));
  }

  /**
   * Lists a repo's issues via the core REST endpoint (not the Search API, whose
   * 30 req/min secondary limit the dashboard would hit fanning across repos).
   * The endpoint returns PRs too — a PR carries a `pull_request` field — so
   * those are dropped. `assignee` narrows to issues assigned to a login.
   */
  async listRepoIssues(
    owner: string,
    repo: string,
    opts: { assignee?: string; state?: string; labels?: string[] } = {},
  ): Promise<IssueSummary[]> {
    const params = new URLSearchParams({
      state: opts.state ?? "open",
      per_page: "50",
      sort: "created",
      direction: "desc",
    });
    if (opts.assignee) params.set("assignee", opts.assignee);
    // GitHub's REST issues endpoint filters by a comma-separated label list
    // (AND semantics — an issue must carry every listed label).
    if (opts.labels?.length) params.set("labels", opts.labels.join(","));
    const items = await this.api<any[]>(`/repos/${owner}/${repo}/issues?${params.toString()}`);
    return items.filter((i) => !i.pull_request).map((i) => toIssueSummary(i, { owner, repo }));
  }

  async issueDetail(owner: string, repo: string, number: number): Promise<IssueDetail> {
    const issue = await this.api<any>(`/repos/${owner}/${repo}/issues/${number}`);
    // A PR is reachable via the issues endpoint too; refuse it so the issue
    // views never render a pull request.
    if (issue.pull_request) throw new Error(`${owner}/${repo}#${number} is a pull request`);
    const comments = await this.api<any[]>(
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    );
    return toIssueDetail(issue, comments, { owner, repo });
  }

  /** Adds assignees to an issue (GitHub merges, it does not replace). */
  async assignIssue(
    owner: string,
    repo: string,
    number: number,
    assignees: string[],
  ): Promise<void> {
    await this.mutate(`/repos/${owner}/${repo}/issues/${number}/assignees`, "POST", { assignees });
  }

  /**
   * Ensures a label exists in the repo, creating it if absent. GitHub returns
   * 404 for a missing label and 422 if a concurrent create already made it;
   * both are treated as "exists now".
   */
  async ensureLabel(owner: string, repo: string, name: string, color = "ededed"): Promise<void> {
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`,
      { headers: this.restHeaders() },
    );
    if (res.ok) return;
    if (res.status !== 404) throw new Error(`github get label -> ${res.status}`);
    const create = await this.fetchImpl(`https://api.github.com/repos/${owner}/${repo}/labels`, {
      method: "POST",
      headers: this.restHeaders(),
      body: JSON.stringify({ name, color }),
    });
    if (!create.ok && create.status !== 422) {
      throw new Error(`github create label -> ${create.status}`);
    }
  }

  /** Adds labels to an issue (GitHub merges with any already present). */
  async addLabels(owner: string, repo: string, number: number, labels: string[]): Promise<void> {
    await this.mutate(`/repos/${owner}/${repo}/issues/${number}/labels`, "POST", { labels });
  }

  private restHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };
  }

  private async mutate(path: string, method: string, body: unknown): Promise<void> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: this.restHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`github ${method} ${path} -> ${res.status}`);
  }
}
