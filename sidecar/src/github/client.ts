/**
 * Minimal GitHub REST client over fetch (no SDK dependency). The fetch
 * implementation is injectable so response shaping can be unit-tested.
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

/** A normalized CI check (CheckRun or legacy commit status). */
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
  /** GraphQL mergeable enum: "MERGEABLE" | "CONFLICTING" | "UNKNOWN". */
  mergeable: string;
  checks: CheckItem[];
  reviewThreads: ReviewThread[];
}

/** A changed file with its unified-diff patch (REST `pulls/:n/files`). */
export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

type FetchFn = typeof fetch;

function parseRepo(
  repositoryUrl?: string,
  htmlUrl?: string,
): { owner: string; repo: string } {
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
    updatedAt: item.updated_at,
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

/** Shapes the GraphQL `pullRequest` payload into a flat PrDetail. */
export function toPrDetail(pr: any): PrDetail {
  const rollupNodes =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
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
    checks: rollupNodes.map(toCheckItem),
    reviewThreads: threadNodes.map((t: any) => ({
      path: t.path ?? null,
      line: t.line ?? null,
      isResolved: Boolean(t.isResolved),
      comments: (t.comments?.nodes ?? []).map((cm: any) => ({
        author: cm.author?.login ?? "",
        body: cm.body ?? "",
        createdAt: cm.createdAt ?? "",
      })),
    })),
  };
}

const PR_DETAIL_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      number title body state isDraft additions deletions mergeable
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

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
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
      `/search/issues?q=${encodeURIComponent(query)}&per_page=50`,
    );
    return (data.items ?? []).filter((i) => i.pull_request).map(toPrSummary);
  }

  async prStatus(owner: string, repo: string, number: number): Promise<PrStatus> {
    const pr = await this.api<any>(`/repos/${owner}/${repo}/pulls/${number}`);
    const checks = await this.api<{ check_runs?: any[] }>(
      `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`,
    );
    return {
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? "unknown",
      checks: summarizeChecks(checks.check_runs ?? []),
    };
  }

  async prDetail(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PrDetail> {
    const data = await this.graphql<{
      repository?: { pullRequest?: any };
    }>(PR_DETAIL_QUERY, { owner, repo, number });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error(`pull request ${owner}/${repo}#${number} not found`);
    return toPrDetail(pr);
  }

  async prFiles(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PrFile[]> {
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
}
