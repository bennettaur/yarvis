import { describe, expect, it } from "bun:test";
import { GitHubClient, summarizeChecks } from "./client.ts";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("github client", () => {
  it("aggregates check-run states", () => {
    const s = summarizeChecks([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
      { status: "in_progress" },
      { status: "completed", conclusion: "skipped" },
    ]);
    expect(s).toEqual({ total: 4, success: 2, failure: 1, pending: 1 });
  });

  it("maps PR search items and drops non-PR issues", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/search/issues": {
          items: [
            {
              number: 1,
              title: "Fix bug",
              html_url: "https://github.com/o/r/pull/1",
              repository_url: "https://api.github.com/repos/o/r",
              user: { login: "me" },
              state: "open",
              updated_at: "2026-01-01",
              pull_request: {},
            },
            {
              number: 2,
              title: "Just an issue",
              html_url: "https://github.com/o/r/issues/2",
              repository_url: "https://api.github.com/repos/o/r",
              state: "open",
            },
          ],
        },
      }),
    );
    const prs = await gh.search("is:pr");
    expect(prs.length).toBe(1);
    expect(prs[0]).toMatchObject({
      number: 1,
      owner: "o",
      repo: "r",
      author: "me",
    });
  });

  it("combines mergeability and checks for PR status", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/pulls/1": {
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "abc" },
        },
        "/repos/o/r/commits/abc/check-runs": {
          check_runs: [{ status: "completed", conclusion: "success" }],
        },
      }),
    );
    const st = await gh.prStatus("o", "r", 1);
    expect(st.mergeable).toBe(true);
    expect(st.mergeableState).toBe("clean");
    expect(st.checks).toMatchObject({ total: 1, success: 1 });
  });
});
