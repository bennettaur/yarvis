import { describe, expect, it } from "bun:test";
import { GitHubClient, toIssueDetail, toIssueSummary } from "./client.ts";

/**
 * Fetch fake that matches the longest registered path prefix (so
 * `/repos/o/r/issues/5/comments` wins over `/repos/o/r/issues/5`) and returns
 * its value with a 200. Unmatched paths 404.
 */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const path = String(url).replace("https://api.github.com", "");
    const key = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("github issue normalizers", () => {
  it("maps a search/REST issue into a provider-neutral summary", () => {
    const summary = toIssueSummary({
      number: 42,
      title: "Broken login",
      html_url: "https://github.com/o/r/issues/42",
      repository_url: "https://api.github.com/repos/o/r",
      state: "open",
      user: { login: "alice" },
      assignees: [{ login: "bob" }, { login: "carol" }],
      labels: [{ name: "bug", color: "ff0000" }, "legacy-string-label"],
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
      comments: 3,
    });
    expect(summary).toMatchObject({
      provider: "github",
      sourceKey: "o/r",
      sourceLabel: "o/r",
      externalId: "42",
      displayId: "#42",
      title: "Broken login",
      state: "open",
      author: "alice",
      assignees: ["bob", "carol"],
      commentCount: 3,
    });
    expect(summary.labels).toEqual([
      { name: "bug", color: "ff0000" },
      { name: "legacy-string-label", color: null },
    ]);
  });

  it("falls back to the caller's owner/repo when the payload has no repository_url", () => {
    const summary = toIssueSummary({ number: 7, title: "x" }, { owner: "acme", repo: "web" });
    expect(summary.sourceKey).toBe("acme/web");
    expect(summary.externalId).toBe("7");
  });

  it("derives owner/repo from an issue html_url when repository_url is absent", () => {
    const summary = toIssueSummary({
      number: 8,
      title: "y",
      html_url: "https://github.com/acme/api/issues/8",
    });
    expect(summary.sourceKey).toBe("acme/api");
  });

  it("attaches comments to a full detail", () => {
    const detail = toIssueDetail(
      {
        number: 1,
        title: "t",
        body: "the body",
        repository_url: "https://api.github.com/repos/o/r",
      },
      [{ user: { login: "dave" }, body: "a comment", created_at: "2026-01-03" }],
    );
    expect(detail.body).toBe("the body");
    expect(detail.comments).toEqual([
      { author: "dave", body: "a comment", createdAt: "2026-01-03" },
    ]);
  });
});

describe("github issue client", () => {
  it("searches issues and drops pull requests", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/search/issues": {
          items: [
            {
              number: 1,
              title: "A PR",
              pull_request: {},
              repository_url: "https://api.github.com/repos/o/r",
            },
            { number: 2, title: "An issue", repository_url: "https://api.github.com/repos/o/r" },
          ],
        },
      }),
    );
    const issues = await gh.searchIssues("is:issue is:open");
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatchObject({ externalId: "2", title: "An issue" });
  });

  it("lists a repo's issues and drops pull requests", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/issues": [
          { number: 3, title: "Real issue", repository_url: "https://api.github.com/repos/o/r" },
          {
            number: 4,
            title: "A PR",
            pull_request: {},
            repository_url: "https://api.github.com/repos/o/r",
          },
        ],
      }),
    );
    const issues = await gh.listRepoIssues("o", "r", { assignee: "me" });
    expect(issues.map((i) => i.externalId)).toEqual(["3"]);
  });

  it("combines an issue with its comments in detail", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/issues/5/comments": [
          { user: { login: "eve" }, body: "hi", created_at: "2026-01-04" },
        ],
        "/repos/o/r/issues/5": {
          number: 5,
          title: "Detailed",
          body: "desc",
          state: "open",
          repository_url: "https://api.github.com/repos/o/r",
        },
      }),
    );
    const detail = await gh.issueDetail("o", "r", 5);
    expect(detail).toMatchObject({ externalId: "5", title: "Detailed", body: "desc" });
    expect(detail.comments[0]).toMatchObject({ author: "eve", body: "hi" });
  });

  it("refuses to treat a pull request as an issue", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/issues/6": { number: 6, title: "Actually a PR", pull_request: {} },
      }),
    );
    await expect(gh.issueDetail("o", "r", 6)).rejects.toThrow("pull request");
  });

  it("creates an issue and returns it as a summary", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: String(url).replace("https://api.github.com", ""),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response(
        JSON.stringify({
          number: 9,
          title: "New thing",
          html_url: "https://github.com/o/r/issues/9",
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;

    const gh = new GitHubClient("t", fetchImpl);
    const issue = await gh.createIssue("o", "r", { title: "New thing", body: "details" });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/repos/o/r/issues",
      body: { title: "New thing", body: "details" },
    });
    expect(issue).toMatchObject({ externalId: "9", title: "New thing", sourceKey: "o/r" });
  });

  it("patches only the fields it is given when updating an issue", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: String(url).replace("https://api.github.com", ""),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const gh = new GitHubClient("t", fetchImpl);
    await gh.updateIssue("o", "r", 5, { state: "closed" });
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/repos/o/r/issues/5",
      body: { state: "closed" },
    });
  });

  it("replaces the whole label and assignee set on an update", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: String(url).replace("https://api.github.com", ""),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const gh = new GitHubClient("t", fetchImpl);
    await gh.updateIssue("o", "r", 5, { labels: ["bug"], assignees: [] });
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/repos/o/r/issues/5",
      body: { labels: ["bug"], assignees: [] },
    });
  });

  it("posts an issue comment", async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        path: String(url).replace("https://api.github.com", ""),
        body: JSON.parse(String(init?.body ?? "null")),
      });
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const gh = new GitHubClient("t", fetchImpl);
    await gh.addIssueComment("o", "r", 5, "looking into it");
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/repos/o/r/issues/5/comments",
      body: { body: "looking into it" },
    });
  });

  it("throws when a comment is rejected", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const gh = new GitHubClient("t", fetchImpl);
    await expect(gh.addIssueComment("o", "r", 5, "hi")).rejects.toThrow(
      "github POST /repos/o/r/issues/5/comments -> 403",
    );
  });

  it("reads a repo's label and assignee sets for the issue editors", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/labels": [{ name: "bug", color: "d73a4a" }, { name: "chore" }],
        "/repos/o/r/assignees": [{ login: "alice" }, { login: "bob" }, {}],
      }),
    );
    const meta = await gh.repoIssueMeta("o", "r");
    expect(meta).toEqual({
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "chore", color: null },
      ],
      // The entry with no login is dropped rather than becoming a blank row.
      assignees: ["alice", "bob"],
      truncated: { labels: false, assignees: false },
    });
  });

  it("reports truncation when a set fills its page", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/labels": Array.from({ length: 100 }, (_, i) => ({ name: `l${i}` })),
        "/repos/o/r/assignees": [{ login: "alice" }],
      }),
    );
    const meta = await gh.repoIssueMeta("o", "r");
    // Only labels filled a page; the short assignee list is complete.
    expect(meta.truncated).toEqual({ labels: true, assignees: false });
  });

  it("throws when an issue update is rejected", async () => {
    const fetchImpl = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const gh = new GitHubClient("t", fetchImpl);
    await expect(gh.updateIssue("o", "r", 5, { title: "x" })).rejects.toThrow(
      "github PATCH /repos/o/r/issues/5 -> 403",
    );
  });

  it("creates a missing label before applying it", async () => {
    const calls: { method: string; path: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = String(url).replace("https://api.github.com", "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      // The label does not exist yet: the existence probe 404s.
      if (method === "GET" && path === "/repos/o/r/labels/in%20progress") {
        return new Response("not found", { status: 404 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const gh = new GitHubClient("t", fetchImpl);
    await gh.ensureLabel("o", "r", "in progress");
    expect(calls).toContainEqual({ method: "GET", path: "/repos/o/r/labels/in%20progress" });
    expect(calls).toContainEqual({ method: "POST", path: "/repos/o/r/labels" });
  });

  it("does not recreate a label that already exists", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url).replace("https://api.github.com", "")}`);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", fetchImpl);
    await gh.ensureLabel("o", "r", "bug");
    expect(calls).toEqual(["GET /repos/o/r/labels/bug"]);
  });

  it("swallows a 422 from a concurrent label create", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      // Probe 404s (missing), then the create races another and 422s.
      return new Response("{}", { status: method === "GET" ? 404 : 422 });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", fetchImpl);
    await expect(gh.ensureLabel("o", "r", "bug")).resolves.toBeUndefined();
  });

  it("throws when the label existence probe fails with a non-404", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const gh = new GitHubClient("t", fetchImpl);
    await expect(gh.ensureLabel("o", "r", "bug")).rejects.toThrow("github get label -> 500");
  });
});
