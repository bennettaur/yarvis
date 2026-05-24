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
}
