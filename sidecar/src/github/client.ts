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
  PrInvolvement,
  PrStatus,
  PrSummary,
  Reviewer,
  ReviewerState,
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
  PrInvolvement,
  PrStatus,
  PrSummary,
  ReviewComment,
  Reviewer,
  ReviewerState,
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

/** Maps GitHub's PullRequestReviewState enum onto the shared ReviewerState. */
function mapReviewState(state: string | undefined | null): ReviewerState {
  switch ((state ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      return "pending";
  }
}

/**
 * Merges GitHub's two reviewer sources — `reviewRequests` (still-outstanding
 * requests) and `latestReviews` (the latest review per person that already
 * submitted one) — into a single provider-neutral list. When both name the
 * same login (a re-request after a previous review), the request wins: the
 * viewer needs to know a fresh look is expected.
 */
function toReviewers(pr: any): Reviewer[] {
  const byLogin = new Map<string, Reviewer>();
  const reviewNodes = pr.latestReviews?.nodes ?? [];
  for (const node of reviewNodes) {
    const login = node?.author?.login;
    if (!login) continue;
    byLogin.set(login, { login, state: mapReviewState(node.state), isRequested: false });
  }
  const requestNodes = pr.reviewRequests?.nodes ?? [];
  // Runs after `latestReviews` so a re-request overwrites the historical review
  // — a fresh look is expected, and the viewer should see "pending" rather than
  // the stale earlier verdict.
  for (const node of requestNodes) {
    const reviewer = node?.requestedReviewer;
    // GraphQL union: User/Mannequin/Bot carry `login`, Team carries `combinedSlug`.
    const login = reviewer?.login ?? reviewer?.combinedSlug;
    if (!login) continue;
    byLogin.set(login, { login, state: "pending", isRequested: true });
  }
  return Array.from(byLogin.values());
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
    headSha: pr.headRefOid ?? "",
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    mergeable: pr.mergeable ?? "UNKNOWN",
    mergeMethods: allowedMergeMethods(repo),
    autoMergeEnabled: Boolean(pr.autoMergeRequest),
    canEnableAutoMerge: Boolean(pr.viewerCanEnableAutoMerge),
    canDisableAutoMerge: Boolean(pr.viewerCanDisableAutoMerge),
    checks: rollupNodes.map(toCheckItem),
    reviewers: toReviewers(pr),
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

/**
 * The fields the "Reviewing" list needs off a PullRequest node. `reviews` is
 * filtered to the viewer, so it answers "what have *I* said on this PR" in the
 * same round trip as the listing itself — the alternative is one prDetail call
 * per row. Requires the enclosing operation to declare `$viewer:String!`.
 */
const PR_INVOLVEMENT_FIELDS = `
  number title url isDraft state createdAt updatedAt
  author{login}
  repository{ name owner{login} }
  reviews(first:20, author:$viewer){ nodes{ state } }
`;

const PR_INVOLVEMENT_SEARCH_QUERY = `
query($q:String!,$viewer:String!,$limit:Int!){
  search(type:ISSUE, query:$q, first:$limit){
    nodes{ ... on PullRequest { ${PR_INVOLVEMENT_FIELDS} } }
  }
}`;

/**
 * Shapes a GraphQL PullRequest node into a PrInvolvement. GraphQL's
 * `PullRequestState` splits closed into CLOSED/MERGED where the REST search only
 * reports open/closed, so the extra bit moves into `merged` and `state` stays on
 * the REST vocabulary the rest of the app already renders.
 */
function toPrInvolvement(node: any): PrInvolvement {
  const state = String(node.state ?? "OPEN").toUpperCase();
  return {
    summary: {
      number: node.number,
      title: node.title ?? "",
      url: node.url ?? "",
      owner: node.repository?.owner?.login ?? "",
      repo: node.repository?.name ?? "",
      author: node.author?.login ?? "",
      draft: Boolean(node.isDraft),
      state: state === "OPEN" ? "open" : "closed",
      createdAt: node.createdAt ?? "",
      updatedAt: node.updatedAt ?? "",
    },
    merged: state === "MERGED",
    myReviewStates: (node.reviews?.nodes ?? [])
      .map((r: any) => mapReviewState(r?.state))
      // A PENDING review is an unsubmitted draft only the viewer can see; it
      // says nothing about their verdict, so it would only add noise.
      .filter((s: ReviewerState) => s !== "pending"),
  };
}

/** Identifies one PR for the batched involvement lookup. */
export interface PrNumberRef {
  owner: string;
  repo: string;
  number: number;
}

/**
 * Builds a single GraphQL operation that fetches every ref by alias, so N PRs
 * cost one request rather than N. Aliases and variable names are index-derived
 * (never caller-supplied), so nothing from a ref reaches the query text.
 */
function buildPrLookupQuery(count: number): string {
  const varDecls = Array.from(
    { length: count },
    (_, i) => `$o${i}:String!,$r${i}:String!,$n${i}:Int!`,
  ).join(",");
  const fields = Array.from(
    { length: count },
    (_, i) =>
      `pr${i}: repository(owner:$o${i},name:$r${i}){ pullRequest(number:$n${i}){ ${PR_INVOLVEMENT_FIELDS} } }`,
  ).join("\n");
  return `query($viewer:String!,${varDecls}){\n${fields}\n}`;
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
      baseRefName headRefName headRefOid
      reviewRequests(first:50){
        nodes{
          requestedReviewer{
            __typename
            ... on User { login }
            ... on Mannequin { login }
            ... on Bot { login }
            ... on Team { combinedSlug }
          }
        }
      }
      latestReviews(first:50){
        nodes{ author{login} state }
      }
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

/**
 * Encodes a repo-relative path for the contents API, refusing anything that
 * would address something other than a file inside the repository.
 *
 * The traversal check is the load-bearing part. `encodeURIComponent` leaves `.`
 * alone, so `..` survives encoding intact, and `fetch` resolves dot-segments
 * against the URL before the request goes out — which turns
 * `contents/../../../../user/repos` into `api.github.com/user/repos`, sent with
 * the user's token. The path reaching here can be chosen by a model reading an
 * untrusted pull request, so this is checked in the client as well as at the
 * route and tool boundaries: the escape is silent, and one missed caller is
 * enough.
 */
export function encodeRepoPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((s) => s === "." || s === "..")) {
    throw new Error("path must stay inside the repository");
  }
  return segments.map(encodeURIComponent).join("/");
}

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

  /**
   * `allowPartial` keeps a response whose `data` is populated even though some
   * fields errored. Only for multi-target operations (the batched PR lookup),
   * where one unresolvable repo would otherwise sink every other result;
   * single-target queries stay strict so a failure surfaces as a failure.
   */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    { allowPartial = false }: { allowPartial?: boolean } = {},
  ): Promise<T> {
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
    if (payload.errors && !(allowPartial && payload.data)) {
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

  /**
   * Search that also reports the viewer's own reviews on each hit. Runs against
   * GraphQL rather than the REST search used by {@link search} because REST has
   * no way to return per-PR review state without a follow-up call per row.
   */
  async searchInvolvement(
    query: string,
    viewerLogin: string,
    limit = 50,
  ): Promise<PrInvolvement[]> {
    const data = await this.graphql<{ search?: { nodes?: any[] } }>(PR_INVOLVEMENT_SEARCH_QUERY, {
      q: query,
      viewer: viewerLogin,
      limit,
    });
    // The ISSUE search type returns issues too; those match no inline fragment
    // and come back as empty objects.
    return (data.search?.nodes ?? []).filter((n) => n?.number).map(toPrInvolvement);
  }

  /**
   * Fetches the named PRs (with the viewer's reviews) in one request. Refs that
   * no longer resolve — repo renamed, PR deleted, access lost — are dropped
   * rather than failing the batch.
   */
  async lookupInvolvement(refs: PrNumberRef[], viewerLogin: string): Promise<PrInvolvement[]> {
    if (refs.length === 0) return [];
    const variables: Record<string, unknown> = { viewer: viewerLogin };
    refs.forEach((ref, i) => {
      variables[`o${i}`] = ref.owner;
      variables[`r${i}`] = ref.repo;
      variables[`n${i}`] = ref.number;
    });
    const data = await this.graphql<Record<string, { pullRequest?: any } | null>>(
      buildPrLookupQuery(refs.length),
      variables,
      { allowPartial: true },
    );
    const found: PrInvolvement[] = [];
    refs.forEach((_ref, i) => {
      const node = data[`pr${i}`]?.pullRequest;
      if (node?.number) found.push(toPrInvolvement(node));
    });
    return found;
  }

  /**
   * One PR's list-row summary. Backs opening a PR the user named directly (by
   * link, or repo + number) rather than picked out of a search result.
   */
  async prSummary(owner: string, repo: string, number: number): Promise<PrSummary> {
    return toPrSummary(await this.api<any>(`/repos/${owner}/${repo}/pulls/${number}`));
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

  /**
   * A file's full text at a commit, for showing the unchanged code around a
   * hunk. Requested as raw rather than JSON: the JSON form base64-encodes the
   * body and refuses outright above 1 MB, while the raw media type streams the
   * bytes and only gives up at 100 MB.
   *
   * A missing path resolves to empty rather than throwing — a file added by the
   * PR has no content on the base side, and that is an ordinary state to be in,
   * not an error the review view should surface.
   */
  async fileContent(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const encoded = encodeRepoPath(path);
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.raw",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (res.status === 404) return "";
    if (!res.ok) throw new Error(`github contents ${path} -> ${res.status}`);
    return res.text();
  }

  /**
   * Entries directly under a directory at a commit, so a caller can find its
   * way around a tree it has never seen. A path that is a file, or absent,
   * comes back empty rather than throwing.
   */
  async listDir(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ path: string; type: string }[]> {
    // The repository root is the empty path, and the trailing slash it would
    // otherwise leave behind has to go with it.
    const encoded = encodeRepoPath(path);
    const suffix = encoded ? `/${encoded}` : "";
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/contents${suffix}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`github contents ${path} -> ${res.status}`);
    const body = (await res.json()) as unknown;
    // The contents endpoint returns an object for a file and an array for a
    // directory; only the latter is a listing.
    if (!Array.isArray(body)) return [];
    return body.map((entry: any) => ({ path: entry.path, type: entry.type }));
  }

  /**
   * Repo-scoped code search, with the matching fragments so a caller can judge
   * a hit without fetching the whole file.
   *
   * GitHub only indexes a repository's default branch, so results describe the
   * base of a pull request rather than its head. That is usually what a caller
   * wants when asking "who else calls this" — the callers are existing code —
   * but it does mean a symbol introduced by the PR itself will not be found.
   */
  async searchCode(
    owner: string,
    repo: string,
    query: string,
    limit = 10,
  ): Promise<{ path: string; fragments: string[] }[]> {
    const q = encodeURIComponent(`${query} repo:${owner}/${repo}`);
    const res = await this.fetchImpl(
      `https://api.github.com/search/code?q=${q}&per_page=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github.text-match+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) throw new Error(`github code search -> ${res.status}`);
    const body = (await res.json()) as { items?: any[] };
    return (body.items ?? []).map((item: any) => ({
      path: item.path,
      fragments: (item.text_matches ?? []).map((m: any) => m.fragment).filter(Boolean),
    }));
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

  /** Opens a new issue and returns it in the provider-neutral summary shape. */
  async createIssue(
    owner: string,
    repo: string,
    input: { title: string; body?: string },
  ): Promise<IssueSummary> {
    const created = await this.mutateJson<unknown>(`/repos/${owner}/${repo}/issues`, "POST", {
      title: input.title,
      body: input.body ?? "",
    });
    return toIssueSummary(created, { owner, repo });
  }

  /**
   * Edits an issue's title, body, or open/closed state. GitHub ignores fields
   * the caller omits, so a partial update leaves the rest untouched.
   */
  async updateIssue(
    owner: string,
    repo: string,
    number: number,
    input: { title?: string; body?: string; state?: "open" | "closed" },
  ): Promise<void> {
    await this.mutate(`/repos/${owner}/${repo}/issues/${number}`, "PATCH", input);
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

  private async sendRest(path: string, method: string, body: unknown): Promise<Response> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: this.restHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`github ${method} ${path} -> ${res.status}`);
    return res;
  }

  private async mutate(path: string, method: string, body: unknown): Promise<void> {
    await this.sendRest(path, method, body);
  }

  /** `mutate` for endpoints whose response body the caller needs. */
  private async mutateJson<T>(path: string, method: string, body: unknown): Promise<T> {
    const res = await this.sendRest(path, method, body);
    return (await res.json()) as T;
  }
}
