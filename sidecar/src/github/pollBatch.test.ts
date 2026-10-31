import { describe, expect, it } from "bun:test";
import { GitHubClient } from "./client.ts";

type Body = { query: string; variables: Record<string, unknown> };

/** A GitHub whose GraphQL endpoint answers through `graphql`, recording each request; REST is never expected. */
function fakeGitHub(graphql: (body: Body) => unknown) {
  const requests: Body[] = [];
  const rest: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path !== "/graphql") {
      rest.push(path);
      return new Response("not found", { status: 404 });
    }
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    return new Response(JSON.stringify(graphql(body)));
  }) as unknown as typeof fetch;
  return { gh: new GitHubClient("poll-batch-token", fetchImpl), requests, rest };
}

/** A PR as the poll query returns it: open, mergeable, one passing and one running check. */
function polledPr(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    url: `https://github.com/o/r/pull/${number}`,
    isDraft: false,
    state: "OPEN",
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    headRefOid: `sha${number}`,
    headRepositoryOwner: { login: "o" },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
                  { __typename: "StatusContext", state: "PENDING" },
                ],
              },
            },
          },
        },
      ],
    },
    reviews: {
      nodes: [{ state: "APPROVED", authorAssociation: "MEMBER", author: { login: "rev" } }],
    },
    ...extra,
  };
}

describe("branchPrStatuses", () => {
  it("reads every branch's PR, status and verdict in one request", async () => {
    const { gh, requests, rest } = fakeGitHub(() => ({
      data: {
        p0: { pullRequests: { nodes: [polledPr(7)] } },
        p1: { pullRequests: { nodes: [] } },
      },
    }));

    const results = await gh.branchPrStatuses([
      { owner: "o", repo: "r", branch: "a" },
      { owner: "o", repo: "r", branch: "b" },
    ]);

    expect(requests).toHaveLength(1);
    expect(rest).toEqual([]);
    expect(results[0]).toEqual({
      ok: true,
      value: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        draft: false,
        status: {
          state: "open",
          merged: false,
          mergeable: true,
          mergeableState: "clean",
          headSha: "sha7",
          checks: { total: 2, success: 1, failure: 0, pending: 1 },
        },
        reviewDecision: "approved",
      },
    });
    expect(results[1]).toEqual({ ok: true, value: null });
  });

  it("passes over a fork's PR on a branch of the same name", async () => {
    const { gh } = fakeGitHub(() => ({
      data: {
        p0: {
          pullRequests: {
            nodes: [polledPr(9, { headRepositoryOwner: { login: "forker" } }), polledPr(7)],
          },
        },
      },
    }));

    const [result] = await gh.branchPrStatuses([{ owner: "O", repo: "r", branch: "main" }]);

    expect(result?.ok && result.value?.number).toBe(7);
  });

  it("leaves the verdict unknown on a draft, which isn't waiting on review", async () => {
    const { gh } = fakeGitHub(() => ({
      data: { p0: { pullRequests: { nodes: [polledPr(7, { isDraft: true })] } } },
    }));

    const [result] = await gh.branchPrStatuses([{ owner: "o", repo: "r", branch: "a" }]);

    expect(result?.ok && result.value?.reviewDecision).toBeNull();
  });
});

describe("prStatusesByNumber", () => {
  it("fails only the PR whose repo GitHub couldn't resolve", async () => {
    const { gh } = fakeGitHub(() => ({
      data: { p0: { pullRequest: polledPr(7) }, p1: null },
      errors: [{ type: "NOT_FOUND", path: ["p1"], message: "Could not resolve to a Repository" }],
    }));

    const results = await gh.prStatusesByNumber([
      { owner: "o", repo: "r", number: 7 },
      { owner: "o", repo: "gone", number: 3 },
    ]);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ ok: false, error: { reason: "not_found" } });
  });

  it("keeps a PR whose check runs the token may not read", async () => {
    const { gh } = fakeGitHub(() => ({
      data: { p0: { pullRequest: polledPr(7) } },
      errors: [
        {
          type: "FORBIDDEN",
          path: ["p0", "pullRequest", "commits", "nodes", 0, "commit", "statusCheckRollup"],
          message: "Resource not accessible by integration",
        },
      ],
    }));

    const [result] = await gh.prStatusesByNumber([{ owner: "o", repo: "r", number: 7 }]);

    expect(result?.ok).toBe(true);
  });

  it("throws a spent rate limit without falling back to REST", async () => {
    const { gh, rest } = fakeGitHub(() => ({
      data: null,
      errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
    }));

    await expect(
      gh.prStatusesByNumber([{ owner: "o", repo: "r", number: 7 }]),
    ).rejects.toMatchObject({ reason: "rate_limited" });
    expect(rest).toEqual([]);
  });

  it("splits a long list into requests of at most 25", async () => {
    const { gh, requests } = fakeGitHub((body) => ({
      data: Object.fromEntries(
        Object.keys(body.variables)
          .filter((k) => k.startsWith("n"))
          .map((k) => [`p${k.slice(1)}`, { pullRequest: polledPr(Number(body.variables[k])) }]),
      ),
    }));
    const refs = Array.from({ length: 30 }, (_, i) => ({ owner: "o", repo: "r", number: i + 1 }));

    const results = await gh.prStatusesByNumber(refs);

    expect(requests.map((r) => Object.keys(r.variables).length / 3)).toEqual([25, 5]);
    expect(results.map((r) => r.ok && r.value.number)).toEqual(refs.map((r) => r.number));
  });
});
