/**
 * A stand-in for api.github.com, answering the REST and GraphQL calls the
 * sidecar's `GitHubClient` makes from the data in `data.ts`. The sidecar finds
 * it through YARVIS_GITHUB_API_URL and YARVIS_GITHUB_GRAPHQL_URL.
 *
 * GraphQL isn't parsed. Every query gets one response holding every field any
 * of the client's queries reads, since the client ignores what it didn't ask
 * for. Aliased lookups (`pr0`, `pr1`, …) are filled in from the `n0`, `n1`, …
 * variables they carry.
 */

import type { Server } from "node:http";
import { type FakeRequest, type FakeResponse, startFakeServer } from "../fakeHttp";
import { type FakeIssue, type FakePull, ISSUES, OWNER, PULLS, REPO, VIEWER } from "./data";

const HTML = `https://github.com/${OWNER}/${REPO}`;
const API_REPO = `https://api.github.com/repos/${OWNER}/${REPO}`;

const findPull = (number: unknown) => PULLS.find((p) => p.number === Number(number));
const findIssue = (number: unknown) => ISSUES.find((i) => i.number === Number(number));

/** A pull request as the REST search and pulls endpoints return it. */
function restPull(pr: FakePull) {
  return {
    number: pr.number,
    title: pr.title,
    html_url: `${HTML}/pull/${pr.number}`,
    repository_url: API_REPO,
    pull_request: { html_url: `${HTML}/pull/${pr.number}` },
    user: { login: pr.author },
    draft: pr.draft,
    state: "open",
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    body: pr.body,
    head: { sha: `sha-${pr.number}`, ref: pr.headRef },
    base: { ref: pr.baseRef },
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
  };
}

function restIssue(issue: FakeIssue) {
  return {
    number: issue.number,
    title: issue.title,
    html_url: `${HTML}/issues/${issue.number}`,
    repository_url: API_REPO,
    state: "open",
    user: { login: issue.author },
    assignees: issue.assignees.map((login) => ({ login })),
    labels: issue.labels,
    body: issue.body,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    comments: issue.comments.length,
  };
}

/** A pull request as the GraphQL queries read it: every field any of them selects. */
function graphPull(pr: FakePull) {
  return {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: `${HTML}/pull/${pr.number}`,
    state: "OPEN",
    isDraft: pr.draft,
    isInMergeQueue: false,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    author: { login: pr.author },
    repository: { name: REPO, owner: { login: OWNER } },
    baseRefName: pr.baseRef,
    headRefName: pr.headRef,
    headRefOid: `sha-${pr.number}`,
    isCrossRepository: false,
    additions: pr.files.reduce((n, f) => n + f.additions, 0),
    deletions: pr.files.reduce((n, f) => n + f.deletions, 0),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: Object.values(pr.reviews).includes("APPROVED") ? "APPROVED" : "REVIEW_REQUIRED",
    autoMergeRequest: null,
    viewerCanEnableAutoMerge: false,
    viewerCanDisableAutoMerge: false,
    reviewRequests: { nodes: pr.requested.map((login) => ({ requestedReviewer: { login } })) },
    latestReviews: {
      nodes: Object.entries(pr.reviews).map(([login, state]) => ({ author: { login }, state })),
    },
    // The viewer's own reviews, for the Reviewing list.
    reviews: {
      nodes: pr.reviews[VIEWER] ? [{ state: pr.reviews[VIEWER] }] : [],
    },
    reviewThreads: {
      nodes: pr.threads.map((t) => ({
        isResolved: false,
        path: t.path,
        line: t.line,
        comments: {
          nodes: [{ author: { login: t.author }, body: t.body, createdAt: pr.updatedAt }],
        },
      })),
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              state: pr.checks.every((c) => c.conclusion === "SUCCESS") ? "SUCCESS" : "PENDING",
              contexts: {
                nodes: pr.checks.map((c) => ({
                  __typename: "CheckRun",
                  name: c.name,
                  status: c.conclusion ? "COMPLETED" : "IN_PROGRESS",
                  conclusion: c.conclusion,
                  detailsUrl: `${HTML}/actions`,
                })),
              },
            },
          },
        },
      ],
    },
    files: {
      nodes: pr.files.map((f) => ({ path: f.filename, viewerViewedState: "UNVIEWED" })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function graphql(body: unknown): FakeResponse {
  const { query = "", variables = {} } = (body ?? {}) as {
    query?: string;
    variables?: Record<string, unknown>;
  };
  if (query.trimStart().startsWith("mutation")) return { json: { data: {} } };

  const data: Record<string, unknown> = {
    viewer: { login: VIEWER },
    // Searches for PRs the viewer has commented on or reviewed.
    search: { nodes: PULLS.filter((p) => p.author !== VIEWER).map(graphPull) },
  };
  const pr = findPull(variables.number);
  data.repository = {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
    defaultBranchRef: { name: "main" },
    pullRequest: pr ? graphPull(pr) : null,
    // Stack lookups: no PR is stacked on another.
    pullRequests: { nodes: [] },
  };
  for (let i = 0; `n${i}` in variables; i++) {
    const aliased = findPull(variables[`n${i}`]);
    data[`pr${i}`] = { pullRequest: aliased ? graphPull(aliased) : null };
  }
  return { json: { data } };
}

/** `/search/issues` serves both the PRs tab and issue search, told apart by the query. */
function searchIssues(q: string): FakeResponse {
  let items: unknown[];
  if (q.includes("is:pr") && q.includes("author:@me")) {
    items = PULLS.filter((p) => p.author === VIEWER).map(restPull);
  } else if (q.includes("is:pr")) {
    items = PULLS.filter((p) => p.requested.includes(VIEWER)).map(restPull);
  } else {
    const words = q
      .replace(/\S+:\S+/g, "")
      .trim()
      .toLowerCase();
    items = ISSUES.filter((i) => !words || i.title.toLowerCase().includes(words)).map(restIssue);
  }
  return { json: { total_count: items.length, items } };
}

function rest({ method, url, body }: FakeRequest): FakeResponse {
  const path = url.pathname;
  if (method === "GET" && path === "/user") return { json: { login: VIEWER } };
  if (method === "GET" && path === "/search/issues") {
    return searchIssues(url.searchParams.get("q") ?? "");
  }
  if (path === "/search/code") return { json: { total_count: 0, items: [] } };

  const repoPath = path.match(/^\/repos\/[^/]+\/[^/]+(\/.*)?$/)?.[1] ?? "";
  /** The number captured by `pattern`'s group, or undefined if `repoPath` doesn't match. */
  const matchNumber = (pattern: RegExp) => repoPath.match(pattern)?.[1];

  const pullNumber = matchNumber(/^\/pulls\/(\d+)$/);
  if (pullNumber) {
    const pr = findPull(pullNumber);
    return pr ? { json: restPull(pr) } : { status: 404, json: {} };
  }
  const filesOf = matchNumber(/^\/pulls\/(\d+)\/files$/);
  if (filesOf) return { json: findPull(filesOf)?.files ?? [] };
  if (/^\/pulls\/\d+\/reviews$/.test(repoPath) && method === "GET") return { json: [] };
  if (/^\/pulls\/\d+\/(reviews|comments)$/.test(repoPath)) return { status: 201, json: { id: 1 } };
  // Finding a workspace branch's PR: none of the demo's branches have one.
  if (repoPath === "/pulls") return { json: [] };
  const checksOf = matchNumber(/^\/commits\/sha-(\d+)\/check-runs$/);
  if (checksOf) {
    const checks = findPull(checksOf)?.checks ?? [];
    return {
      json: {
        check_runs: checks.map((c) => ({
          name: c.name,
          status: c.conclusion ? "completed" : "in_progress",
          conclusion: c.conclusion?.toLowerCase() ?? null,
        })),
      },
    };
  }
  // File contents for expanding diff context. Empty, as for a new file.
  if (repoPath.startsWith("/contents/")) return { status: 404, json: {} };

  if (repoPath === "/issues" && method === "GET") {
    const assignee = url.searchParams.get("assignee");
    const issues = ISSUES.filter((i) => !assignee || i.assignees.includes(assignee));
    return { json: issues.map(restIssue) };
  }
  const issueNumber = matchNumber(/^\/issues\/(\d+)$/);
  if (issueNumber && method === "GET") {
    const issue = findIssue(issueNumber);
    return issue ? { json: restIssue(issue) } : { status: 404, json: {} };
  }
  const commentsOf = matchNumber(/^\/issues\/(\d+)\/comments$/);
  if (commentsOf && method === "GET") {
    return {
      json: (findIssue(commentsOf)?.comments ?? []).map((c) => ({
        user: { login: c.author },
        body: c.body,
        created_at: c.createdAt,
      })),
    };
  }
  if (repoPath === "/labels") {
    return { json: [...new Map(ISSUES.flatMap((i) => i.labels).map((l) => [l.name, l])).values()] };
  }
  if (repoPath === "/assignees") {
    return { json: [VIEWER, "priya-shah", "sam-okafor"].map((login) => ({ login })) };
  }
  // Writes (new issues, comments, labels, assignees) succeed without being kept.
  if (method !== "GET") {
    return {
      status: 201,
      json: { number: 999, ...(body as object), html_url: `${HTML}/issues/999` },
    };
  }
  return { status: 404, json: { message: "Not Found" } };
}

export function handleGithubRequest(req: FakeRequest): FakeResponse {
  if (req.url.pathname === "/graphql") return graphql(req.body);
  return rest(req);
}

export function startFakeGithub(port: number): Promise<Server> {
  return startFakeServer("fake-github", port, handleGithubRequest);
}
