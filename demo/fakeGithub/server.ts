/**
 * A stand-in for api.github.com, answering the REST and GraphQL calls the
 * sidecar's `GitHubClient` makes from the data in `data.ts`. The sidecar finds
 * it through YARVIS_GITHUB_API_URL and YARVIS_GITHUB_GRAPHQL_URL.
 *
 * GraphQL isn't parsed. Every query gets the same response, holding the fields
 * the client's queries read; the client ignores fields it didn't ask for. A new
 * client query that reads a field `toGraphqlPull` lacks gets undefined, so add
 * the field there.
 */

import type { Server } from "node:http";
import { type FakeRequest, type FakeResponse, startFakeServer } from "../fakeHttp";
import { type FakeIssue, type FakePull, ISSUES, OWNER, PEOPLE, PULLS, REPO, VIEWER } from "./data";

const REPO_HTML_URL = `https://github.com/${OWNER}/${REPO}`;
const REPO_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;

/**
 * The issues as this run has left them. New issues and comments are kept, so
 * the detail a flow reopens after writing shows what it wrote. Copied, so the
 * seed data in `data.ts` stays as written.
 */
const issues: FakeIssue[] = ISSUES.map((i) => ({ ...i, comments: [...i.comments] }));

const findPull = (number: unknown) => PULLS.find((p) => p.number === Number(number));
const findIssue = (number: unknown) => issues.find((i) => i.number === Number(number));

/** The next number GitHub would hand out, after every PR and issue so far. */
function nextNumber(): number {
  return Math.max(...PULLS.map((p) => p.number), ...issues.map((i) => i.number)) + 1;
}

/** A pull request as the REST search and pulls endpoints return it. */
function toRestPull(pr: FakePull) {
  return {
    number: pr.number,
    title: pr.title,
    html_url: `${REPO_HTML_URL}/pull/${pr.number}`,
    repository_url: REPO_API_URL,
    pull_request: { html_url: `${REPO_HTML_URL}/pull/${pr.number}` },
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

function toRestIssue(issue: FakeIssue) {
  return {
    number: issue.number,
    title: issue.title,
    html_url: `${REPO_HTML_URL}/issues/${issue.number}`,
    repository_url: REPO_API_URL,
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

function toRestComment(c: FakeIssue["comments"][number]) {
  return { user: { login: c.author }, body: c.body, created_at: c.createdAt };
}

/** The combined check state, as GitHub reports it: any failure wins over anything still running. */
function rollupState(pr: FakePull): "SUCCESS" | "FAILURE" | "PENDING" {
  if (pr.checks.some((c) => c.conclusion === "FAILURE")) return "FAILURE";
  if (pr.checks.some((c) => c.conclusion === null)) return "PENDING";
  return "SUCCESS";
}

/** A pull request as the GraphQL queries read it: the fields any of them selects. */
function toGraphqlPull(pr: FakePull) {
  return {
    id: `PR_${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    url: `${REPO_HTML_URL}/pull/${pr.number}`,
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
    reviewRequests: {
      nodes: pr.requestedReviewers.map((login) => ({ requestedReviewer: { login } })),
    },
    latestReviews: {
      nodes: Object.entries(pr.reviews).map(([login, state]) => ({ author: { login }, state })),
    },
    // The viewer's own reviews, for the Reviewing list.
    reviews: {
      nodes: pr.reviews[VIEWER] ? [{ state: pr.reviews[VIEWER] }] : [],
    },
    reviewThreads: {
      nodes: pr.reviewThreads.map((t) => ({
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
              state: rollupState(pr),
              contexts: {
                nodes: pr.checks.map((c) => ({
                  __typename: "CheckRun",
                  name: c.name,
                  status: c.conclusion ? "COMPLETED" : "IN_PROGRESS",
                  conclusion: c.conclusion,
                  detailsUrl: `${REPO_HTML_URL}/actions`,
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

function handleGraphql(body: unknown): FakeResponse {
  const { query = "", variables = {} } = (body ?? {}) as {
    query?: string;
    variables?: Record<string, unknown>;
  };
  // Mutations (merge, auto-merge, marking a file viewed) succeed without changing anything.
  if (query.trimStart().startsWith("mutation")) return { json: { data: {} } };

  // Which query reads which key:
  //   viewer                   the viewer lookup
  //   search                   PRs the viewer is involved in (the Reviewing tab)
  //   repository.pullRequest   PR detail, viewed files and the stack's first layer ($number)
  //   repository.pullRequests  the stack's layers above and below (none: nothing is stacked)
  //   pr0, pr1, …              batched lookups by PR, from their n0, n1, … variables
  // The stack's c0, c1, … behind-base comparisons are left out, so every layer
  // reads as up to date.
  const data: Record<string, unknown> = {
    viewer: { login: VIEWER },
    // Searches for PRs the viewer has commented on or reviewed.
    search: { nodes: PULLS.filter((p) => p.author !== VIEWER).map(toGraphqlPull) },
  };
  const pr = findPull(variables.number);
  data.repository = {
    mergeCommitAllowed: true,
    squashMergeAllowed: true,
    rebaseMergeAllowed: false,
    defaultBranchRef: { name: "main" },
    pullRequest: pr ? toGraphqlPull(pr) : null,
    // Stack lookups: no PR is stacked on another.
    pullRequests: { nodes: [] },
  };
  for (let i = 0; `n${i}` in variables; i++) {
    const aliased = findPull(variables[`n${i}`]);
    data[`pr${i}`] = { pullRequest: aliased ? toGraphqlPull(aliased) : null };
  }
  return { json: { data } };
}

/** `/search/issues` serves both the PRs tab and issue search, told apart by the query. */
function searchIssues(q: string): FakeResponse {
  let items: unknown[];
  if (q.includes("is:pr") && q.includes("author:@me")) {
    items = PULLS.filter((p) => p.author === VIEWER).map(toRestPull);
  } else if (q.includes("is:pr") && q.includes("review-requested:@me")) {
    items = PULLS.filter((p) => p.requestedReviewers.includes(VIEWER)).map(toRestPull);
  } else {
    const words = q
      .replace(/\S+:\S+/g, "")
      .trim()
      .toLowerCase();
    items = issues.filter((i) => !words || i.title.toLowerCase().includes(words)).map(toRestIssue);
  }
  return { json: { total_count: items.length, items } };
}

function handleRest({ method, url, body }: FakeRequest): FakeResponse {
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
    return pr ? { json: toRestPull(pr) } : { status: 404, json: {} };
  }
  const filesPullNumber = matchNumber(/^\/pulls\/(\d+)\/files$/);
  if (filesPullNumber) return { json: findPull(filesPullNumber)?.files ?? [] };
  const reviewsPullNumber = matchNumber(/^\/pulls\/(\d+)\/reviews$/);
  if (reviewsPullNumber && method === "GET") {
    const reviews = findPull(reviewsPullNumber)?.reviews ?? {};
    return {
      json: Object.entries(reviews).map(([login, state]) => ({
        user: { login },
        state,
        author_association: "MEMBER",
      })),
    };
  }
  if (/^\/pulls\/\d+\/(reviews|comments)$/.test(repoPath)) return { status: 201, json: { id: 1 } };
  // Finding a workspace branch's PR: none of the demo's branches have one.
  if (repoPath === "/pulls") return { json: [] };
  const checksPullNumber = matchNumber(/^\/commits\/sha-(\d+)\/check-runs$/);
  if (checksPullNumber) {
    const checks = findPull(checksPullNumber)?.checks ?? [];
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
    const listed = issues.filter((i) => !assignee || i.assignees.includes(assignee));
    return { json: listed.map(toRestIssue) };
  }
  if (repoPath === "/issues" && method === "POST") {
    const input = body as { title: string; body?: string };
    const issue: FakeIssue = {
      number: nextNumber(),
      title: input.title,
      author: VIEWER,
      assignees: [],
      labels: [],
      body: input.body ?? "",
      createdAt: new Date().toISOString(),
      comments: [],
    };
    issues.unshift(issue);
    return { status: 201, json: toRestIssue(issue) };
  }
  const issueNumber = matchNumber(/^\/issues\/(\d+)$/);
  if (issueNumber && method === "GET") {
    const issue = findIssue(issueNumber);
    return issue ? { json: toRestIssue(issue) } : { status: 404, json: {} };
  }
  const commentsIssueNumber = matchNumber(/^\/issues\/(\d+)\/comments$/);
  if (commentsIssueNumber && method === "GET") {
    return { json: (findIssue(commentsIssueNumber)?.comments ?? []).map(toRestComment) };
  }
  if (commentsIssueNumber && method === "POST") {
    const issue = findIssue(commentsIssueNumber);
    if (!issue) return { status: 404, json: { message: "Not Found" } };
    const comment = {
      author: VIEWER,
      body: (body as { body: string }).body,
      createdAt: new Date().toISOString(),
    };
    issue.comments.push(comment);
    return { status: 201, json: toRestComment(comment) };
  }
  if (repoPath === "/labels") {
    return { json: [...new Map(issues.flatMap((i) => i.labels).map((l) => [l.name, l])).values()] };
  }
  if (repoPath === "/assignees") {
    return { json: PEOPLE.map((login) => ({ login })) };
  }
  // Other writes (labels, assignees, edits) succeed without being kept.
  if (method !== "GET") {
    return {
      status: 201,
      json: { number: 999, ...(body as object), html_url: `${REPO_HTML_URL}/issues/999` },
    };
  }
  return { status: 404, json: { message: "Not Found" } };
}

export function handleGithubRequest(req: FakeRequest): FakeResponse {
  if (req.url.pathname === "/graphql") return handleGraphql(req.body);
  return handleRest(req);
}

export function startFakeGithub(port: number): Promise<Server> {
  return startFakeServer("fake-github", port, handleGithubRequest);
}
