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

const findPull = (number: unknown) => PULLS.find((p) => p.number === Number(number));
const findIssue = (number: unknown) => ISSUES.find((i) => i.number === Number(number));

/** A PR's head commit: a real-looking sha where the data gives one, else a placeholder. */
const headShaOf = (pr: FakePull) => pr.headSha ?? `sha-${pr.number}`;

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
    head: { sha: headShaOf(pr), ref: pr.headRef },
    base: { ref: pr.baseRef },
    merged: false,
    mergeable: !pr.conflicting,
    mergeable_state: pr.conflicting ? "dirty" : "clean",
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

/** The combined check state, as GitHub reports it: any failure wins over anything still running. */
function rollupState(pr: FakePull): "SUCCESS" | "FAILURE" | "PENDING" {
  if (pr.checks.some((c) => c.conclusion === "FAILURE")) return "FAILURE";
  if (pr.checks.some((c) => c.conclusion === null)) return "PENDING";
  return "SUCCESS";
}

const threadId = (pr: FakePull, index: number) => `PRRT_${pr.number}_${index}`;

interface FakeReply {
  id: string;
  author: { login: string };
  body: string;
  createdAt: string;
}

/**
 * What a demo flow has done to the review threads: replies and resolve state,
 * by thread id. Kept for the life of the process, so a reply posted in a flow
 * shows on the refetch that follows it.
 */
const threadState = new Map<string, { resolved: boolean; replies: FakeReply[] }>();

function stateOf(id: string) {
  let state = threadState.get(id);
  if (!state) {
    state = { resolved: false, replies: [] };
    threadState.set(id, state);
  }
  return state;
}

/** The thread mutations, or null for any other mutation. */
function threadMutation(query: string, variables: Record<string, unknown>): FakeResponse | null {
  const id = String(variables.id ?? "");
  if (query.includes("addPullRequestReviewThreadReply")) {
    const replies = stateOf(id).replies;
    const reply = {
      id: `${id}_reply_${replies.length}`,
      author: { login: VIEWER },
      body: String(variables.body ?? ""),
      createdAt: new Date().toISOString(),
    };
    replies.push(reply);
    return { json: { data: { addPullRequestReviewThreadReply: { comment: { id: reply.id } } } } };
  }
  // `unresolveReviewThread` contains `resolveReviewThread`, so it is checked first.
  if (query.includes("unresolveReviewThread")) {
    stateOf(id).resolved = false;
    return { json: { data: { unresolveReviewThread: { thread: { id } } } } };
  }
  if (query.includes("resolveReviewThread")) {
    stateOf(id).resolved = true;
    return { json: { data: { resolveReviewThread: { thread: { id } } } } };
  }
  return null;
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
    headRefOid: headShaOf(pr),
    isCrossRepository: false,
    additions: pr.files.reduce((n, f) => n + f.additions, 0),
    deletions: pr.files.reduce((n, f) => n + f.deletions, 0),
    mergeable: pr.conflicting ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: pr.conflicting ? "DIRTY" : "CLEAN",
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
    // The viewer's own reviews: their states for the Reviewing list, and the
    // commit and time of each for "since your last review".
    reviews: {
      nodes: [
        ...(pr.reviews[VIEWER] ? [{ state: pr.reviews[VIEWER] }] : []),
        ...(pr.viewerReview
          ? [
              {
                state: pr.viewerReview.state,
                submittedAt: pr.viewerReview.submittedAt,
                commit: { oid: pr.viewerReview.commit },
              },
            ]
          : []),
      ],
    },
    reviewThreads: {
      nodes: pr.reviewThreads.map((t, i) => {
        const id = threadId(pr, i);
        const state = threadState.get(id);
        return {
          id,
          isResolved: state?.resolved ?? false,
          isOutdated: false,
          diffSide: "RIGHT",
          viewerCanReply: true,
          viewerCanResolve: true,
          viewerCanUnresolve: true,
          path: t.path,
          line: t.line,
          comments: {
            nodes: [
              {
                id: `PRRC_${pr.number}_${i}`,
                author: { login: t.author },
                body: t.body,
                createdAt: pr.updatedAt,
              },
              ...(state?.replies ?? []),
            ],
          },
        };
      }),
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
  if (query.trimStart().startsWith("mutation")) {
    // Thread replies and resolving are kept, so the review shows them. Other
    // mutations (merge, auto-merge, marking a file viewed) succeed without
    // changing anything.
    return threadMutation(query, variables) ?? { json: { data: {} } };
  }

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
    items = ISSUES.filter((i) => !words || i.title.toLowerCase().includes(words)).map(toRestIssue);
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
  // How far a PR's head is past the viewer's review of it; any other pair is unknown.
  const compared = repoPath.match(/^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/);
  if (compared) {
    const pr = PULLS.find(
      (p) => p.viewerReview?.commit === compared[1] && p.headSha === compared[2],
    );
    return pr?.viewerReview
      ? { json: { status: "ahead", ahead_by: pr.viewerReview.commitsSince } }
      : { status: 404, json: { message: "Not Found" } };
  }
  // Finding a workspace branch's PR: none of the demo's branches have one.
  if (repoPath === "/pulls") return { json: [] };
  // Asked by either form of a PR's head: its sha, or the `sha-N` placeholder.
  const checksSha = repoPath.match(/^\/commits\/([^/]+)\/check-runs$/)?.[1];
  if (checksSha) {
    const pr = PULLS.find((p) => checksSha === headShaOf(p) || checksSha === `sha-${p.number}`);
    const checks = pr?.checks ?? [];
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
    return { json: issues.map(toRestIssue) };
  }
  const issueNumber = matchNumber(/^\/issues\/(\d+)$/);
  if (issueNumber && method === "GET") {
    const issue = findIssue(issueNumber);
    return issue ? { json: toRestIssue(issue) } : { status: 404, json: {} };
  }
  const commentsIssueNumber = matchNumber(/^\/issues\/(\d+)\/comments$/);
  if (commentsIssueNumber && method === "GET") {
    return {
      json: (findIssue(commentsIssueNumber)?.comments ?? []).map((c) => ({
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
    return { json: PEOPLE.map((login) => ({ login })) };
  }
  // Writes (new issues, comments, labels, assignees) succeed without being kept.
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
