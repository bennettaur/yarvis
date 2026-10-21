import { describe, expect, it } from "bun:test";
import { GitHubClient } from "./client.ts";
import { GitHubError } from "./errors.ts";

type Handler = (body: { query: string; variables: Record<string, unknown> }) => Response;

/**
 * A GitHub whose GraphQL endpoint answers through `graphql` and whose REST
 * paths answer from `rest` by prefix. Records every request as GRAPHQL or the
 * REST path.
 */
function fakeGitHub(graphql: Handler, rest: Record<string, unknown> = {}) {
  const requests: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/graphql") {
      requests.push("GRAPHQL");
      return graphql(JSON.parse(String(init?.body)));
    }
    requests.push(path);
    const key = Object.keys(rest)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(rest[key]));
  }) as unknown as typeof fetch;
  return { gh: new GitHubClient("t", fetchImpl), requests };
}

const data = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ data: value }), { headers });

const graphqlErrors = (errors: unknown[]) => new Response(JSON.stringify({ data: null, errors }));

const REST_PR = {
  state: "open",
  merged: false,
  mergeable: true,
  mergeable_state: "clean",
  head: { sha: "abc" },
};
const REST_CHECKS = { check_runs: [{ status: "completed", conclusion: "success" }] };

describe("reads through GraphQL", () => {
  it("reads a PR's status in one request, counting check runs and commit statuses", async () => {
    const { gh, requests } = fakeGitHub(() =>
      data({
        repository: {
          pullRequest: {
            state: "OPEN",
            merged: false,
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                          { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
                          { __typename: "StatusContext", state: "FAILURE" },
                          { __typename: "StatusContext", state: "EXPECTED" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    );
    expect(await gh.prStatus("o", "r", 1)).toEqual({
      state: "open",
      merged: false,
      mergeable: false,
      mergeableState: "dirty",
      checks: { total: 4, success: 1, failure: 1, pending: 2 },
    });
    expect(requests).toEqual(["GRAPHQL"]);
  });

  it("finds a branch's PR, ignoring a fork's branch of the same name", async () => {
    const pr = (number: number, headOwner: string) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      isDraft: false,
      state: "MERGED",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-02",
      author: { login: "me" },
      repository: { name: "r", owner: { login: "o" } },
      headRepositoryOwner: { login: headOwner },
    });
    const { gh } = fakeGitHub(() =>
      data({ repository: { pullRequests: { nodes: [pr(9, "a-fork"), pr(7, "O")] } } }),
    );
    expect(await gh.findPrByBranch("o", "r", "feature")).toMatchObject({
      number: 7,
      owner: "o",
      repo: "r",
      state: "closed",
    });
  });

  it("keeps only issues with every requested label", async () => {
    const issue = (number: number, labels: string[]) => ({
      number,
      title: `Issue ${number}`,
      url: `https://github.com/o/r/issues/${number}`,
      state: "OPEN",
      createdAt: "2026-10-01",
      updatedAt: "2026-10-02",
      author: { login: "me" },
      assignees: { nodes: [{ login: "you" }] },
      labels: { nodes: labels.map((name) => ({ name, color: "ffffff" })) },
      comments: { totalCount: 3 },
    });
    const { gh } = fakeGitHub(() =>
      data({ repository: { issues: { nodes: [issue(1, ["bug", "p1"]), issue(2, ["bug"])] } } }),
    );
    const issues = await gh.listRepoIssues("o", "r", { labels: ["bug", "p1"] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      externalId: "1",
      sourceKey: "o/r",
      state: "open",
      assignees: ["you"],
      commentCount: 3,
    });
  });

  it("refuses a pull request asked for as an issue", async () => {
    const { gh } = fakeGitHub(() =>
      data({ repository: { issueOrPullRequest: { __typename: "PullRequest" } } }),
    );
    await expect(gh.issueDetail("o", "r", 6)).rejects.toThrow("pull request");
  });

  it("marks the label list truncated when GitHub has another page", async () => {
    const { gh } = fakeGitHub(() =>
      data({
        repository: {
          labels: { nodes: [{ name: "bug", color: "f00" }], pageInfo: { hasNextPage: true } },
          assignableUsers: { nodes: [{ login: "you" }], pageInfo: { hasNextPage: false } },
        },
      }),
    );
    expect(await gh.repoIssueMeta("o", "r")).toEqual({
      labels: [{ name: "bug", color: "f00" }],
      assignees: ["you"],
      truncated: { labels: true, assignees: false },
    });
  });

  it("asks for the signed-in login once per token", async () => {
    const { gh, requests } = fakeGitHub(() => data({ viewer: { login: "me" } }));
    expect(await gh.viewer()).toEqual({ login: "me" });
    expect(await gh.viewer()).toEqual({ login: "me" });
    expect(requests).toEqual(["GRAPHQL"]);
  });
});

describe("falls back to REST", () => {
  const rest = { "/repos/o/r/pulls/1": REST_PR, "/repos/o/r/commits/abc/check-runs": REST_CHECKS };

  it("when GraphQL's rate limit is spent", async () => {
    const { gh, requests } = fakeGitHub(
      () => graphqlErrors([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]),
      rest,
    );
    expect(await gh.prStatus("o", "r", 1)).toMatchObject({
      mergeable: true,
      mergeableState: "clean",
    });
    expect(requests).toEqual([
      "GRAPHQL",
      "/repos/o/r/pulls/1",
      "/repos/o/r/commits/abc/check-runs",
      "/repos/o/r/commits/abc/status",
    ]);
  });

  it("when GitHub's GraphQL API is failing", async () => {
    const { gh } = fakeGitHub(() => new Response("oops", { status: 502 }), rest);
    expect(await gh.prStatus("o", "r", 1)).toMatchObject({ mergeable: true });
  });

  it("straight away once a reply shows GraphQL's budget is spent", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const { gh, requests } = fakeGitHub(
      () =>
        data(
          { viewer: { login: "me" } },
          { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset },
        ),
      rest,
    );
    await gh.viewer();
    await gh.prStatus("o", "r", 1);
    expect(requests).toEqual([
      "GRAPHQL",
      "/repos/o/r/pulls/1",
      "/repos/o/r/commits/abc/check-runs",
      "/repos/o/r/commits/abc/status",
    ]);
  });

  it("but not when GitHub refuses the token access", async () => {
    const { gh, requests } = fakeGitHub(
      () =>
        graphqlErrors([
          { type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." },
        ]),
      rest,
    );
    const error = await gh.prStatus("o", "r", 1).catch((e) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).reason).toBe("sso_required");
    expect(requests).toEqual(["GRAPHQL"]);
  });

  it("but not when the PR doesn't exist", async () => {
    const { gh, requests } = fakeGitHub(() => data({ repository: { pullRequest: null } }), rest);
    const error = await gh.prStatus("o", "r", 1).catch((e) => e);
    expect((error as GitHubError).reason).toBe("not_found");
    expect(requests).toEqual(["GRAPHQL"]);
  });
});

describe("GraphQL reads match REST", () => {
  it("doesn't narrow an unfiltered issue list to unassigned issues", async () => {
    let sent: Record<string, unknown> = {};
    const { gh } = fakeGitHub(({ variables }) => {
      sent = variables;
      return data({ repository: { issues: { nodes: [] } } });
    });
    await gh.listRepoIssues("o", "r");
    expect(sent.filterBy).toEqual({});
    await gh.listRepoIssues("o", "r", { assignee: "me" });
    expect(sent.filterBy).toEqual({ assignee: "me" });
  });

  it("still reads a PR's status when a fine-grained token can't see its checks", async () => {
    const { gh, requests } = fakeGitHub(
      () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  state: "OPEN",
                  merged: false,
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
                },
              },
            },
            errors: [
              {
                type: "FORBIDDEN",
                path: [
                  "repository",
                  "pullRequest",
                  "commits",
                  "nodes",
                  0,
                  "commit",
                  "statusCheckRollup",
                ],
              },
            ],
          }),
        ),
    );
    expect(await gh.prStatus("o", "r", 1)).toMatchObject({
      mergeable: true,
      mergeableState: "clean",
      checks: { total: 0 },
    });
    expect(requests).toEqual(["GRAPHQL"]);
  });

  it("collapses reviews to the latest verdict from someone who could merge", async () => {
    const review = (login: string, state: string, authorAssociation = "MEMBER") => ({
      state,
      authorAssociation,
      author: { login },
    });
    const { gh } = fakeGitHub(() =>
      data({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [
                review("a", "APPROVED"),
                review("a", "DISMISSED"),
                review("drive-by", "APPROVED", "NONE"),
                review("b", "COMMENTED"),
              ],
            },
          },
        },
      }),
    );
    expect(await gh.prReviewDecision("o", "r", 1)).toBe("review_required");
  });

  it("reads an issue with its comments", async () => {
    const { gh } = fakeGitHub(() =>
      data({
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 5,
            title: "Detailed",
            url: "https://github.com/o/r/issues/5",
            state: "OPEN",
            createdAt: "2026-10-01",
            updatedAt: "2026-10-02",
            author: { login: "me" },
            assignees: { nodes: [] },
            labels: { nodes: [] },
            comments: { totalCount: 1 },
            body: "desc",
            thread: { nodes: [{ body: "hi", createdAt: "2026-10-03", author: { login: "eve" } }] },
          },
        },
      }),
    );
    const detail = await gh.issueDetail("o", "r", 5);
    expect(detail).toMatchObject({ externalId: "5", title: "Detailed", body: "desc" });
    expect(detail.comments).toEqual([{ author: "eve", body: "hi", createdAt: "2026-10-03" }]);
  });

  it("shares one request between concurrent login lookups, and retries after a failure", async () => {
    let calls = 0;
    const { gh } = fakeGitHub(() => {
      calls++;
      return calls === 1
        ? graphqlErrors([{ type: "FORBIDDEN", message: "no" }])
        : data({ viewer: { login: "me" } });
    });
    await expect(gh.viewer()).rejects.toThrow();
    const [a, b] = await Promise.all([gh.viewer(), gh.viewer()]);
    expect([a, b]).toEqual([{ login: "me" }, { login: "me" }]);
    expect(calls).toBe(2);
  });
});

describe("falls back to REST when GraphQL can't answer", () => {
  const rest = { "/repos/o/r/pulls/1": REST_PR, "/repos/o/r/commits/abc/check-runs": REST_CHECKS };
  const cases: [string, Handler][] = [
    [
      "the network fails",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
    ["there's no GraphQL endpoint", () => new Response("not found", { status: 404 })],
    ["the reply is empty", () => new Response("{}")],
    ["the reply is an HTML page", () => new Response("<html>Unicorn</html>")],
  ];
  for (const [when, graphql] of cases) {
    it(`when ${when}`, async () => {
      const { gh } = fakeGitHub(graphql, rest);
      expect(await gh.prStatus("o", "r", 1)).toMatchObject({ mergeable: true });
    });
  }

  it("but not when GitHub rejects the token", async () => {
    const { gh, requests } = fakeGitHub(
      () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
      rest,
    );
    const error = await gh.prStatus("o", "r", 1).catch((e) => e);
    expect((error as GitHubError).reason).toBe("unauthorized");
    expect(requests).toEqual(["GRAPHQL"]);
  });
});
