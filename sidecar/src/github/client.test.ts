import { describe, expect, it } from "bun:test";
import {
  encodeRepoPath,
  GitHubClient,
  summarizeChecks,
  summarizeReviewDecision,
  toPrDetail,
} from "./client.ts";

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

  it("counts only each reviewer's latest verdict, blocking over approving", () => {
    const reviews = [
      { state: "APPROVED", user: { login: "ada" } },
      { state: "COMMENTED", user: { login: "grace" } },
      { state: "CHANGES_REQUESTED", user: { login: "grace" } },
      { state: "APPROVED", user: { login: "grace" } },
    ];
    expect(summarizeReviewDecision(reviews)).toBe("approved");
    expect(summarizeReviewDecision(reviews.slice(0, 3))).toBe("changes_requested");
    expect(summarizeReviewDecision([{ state: "COMMENTED", user: { login: "ada" } }])).toBe(
      "review_required",
    );
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
              created_at: "2025-12-30",
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
      createdAt: "2025-12-30",
      updatedAt: "2026-01-01",
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

  it("normalizes CheckRun and StatusContext into a flat check list", () => {
    const detail = toPrDetail({
      number: 5,
      title: "Add feature",
      body: "## Summary\nDoes a thing.",
      state: "OPEN",
      isDraft: false,
      additions: 10,
      deletions: 2,
      mergeable: "MERGEABLE",
      author: { login: "me" },
      baseRefName: "main",
      headRefName: "feature",
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: "src/a.ts",
            line: 12,
            comments: {
              nodes: [{ author: { login: "rev" }, body: "nit", createdAt: "2026-01-01" }],
            },
          },
        ],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "build",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      detailsUrl: "https://ci/build",
                    },
                    {
                      __typename: "StatusContext",
                      context: "legacy",
                      state: "FAILURE",
                      targetUrl: "https://ci/legacy",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    expect(detail).toMatchObject({
      number: 5,
      author: "me",
      baseRef: "main",
      headRef: "feature",
      mergeable: "MERGEABLE",
    });
    expect(detail.checks).toEqual([
      { name: "build", status: "COMPLETED", conclusion: "SUCCESS", url: "https://ci/build" },
      { name: "legacy", status: "COMPLETED", conclusion: "FAILURE", url: "https://ci/legacy" },
    ]);
    expect(detail.reviewThreads[0]).toMatchObject({
      path: "src/a.ts",
      line: 12,
      isResolved: false,
    });
    expect(detail.reviewThreads[0]!.comments[0]).toMatchObject({
      author: "rev",
      body: "nit",
    });
  });

  it("fetches PR detail over graphql", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/graphql": {
          data: {
            repository: {
              pullRequest: {
                number: 9,
                title: "T",
                body: "b",
                state: "OPEN",
                isDraft: true,
                additions: 1,
                deletions: 0,
                mergeable: "UNKNOWN",
                author: { login: "me" },
                baseRefName: "main",
                headRefName: "f",
                reviewThreads: { nodes: [] },
                commits: { nodes: [] },
              },
            },
          },
        },
      }),
    );
    const detail = await gh.prDetail("o", "r", 9);
    expect(detail).toMatchObject({ number: 9, draft: true, checks: [] });
  });

  it("reads merge methods and auto-merge state from the detail payload", () => {
    const detail = toPrDetail(
      {
        number: 5,
        title: "t",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        autoMergeRequest: { enabledAt: "2026-01-01" },
        viewerCanEnableAutoMerge: false,
        viewerCanDisableAutoMerge: true,
        author: { login: "me" },
        reviewThreads: { nodes: [] },
        commits: { nodes: [] },
      },
      { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true },
    );
    expect(detail.mergeMethods).toEqual(["SQUASH", "REBASE"]);
    expect(detail.autoMergeEnabled).toBe(true);
    expect(detail.canEnableAutoMerge).toBe(false);
    expect(detail.canDisableAutoMerge).toBe(true);
  });

  it("merges review requests and latest reviews into one reviewer list", () => {
    const detail = toPrDetail({
      number: 1,
      state: "OPEN",
      author: { login: "me" },
      reviewThreads: { nodes: [] },
      commits: { nodes: [] },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: "User", login: "alice" } },
          { requestedReviewer: { __typename: "Team", combinedSlug: "org/frontend" } },
        ],
      },
      latestReviews: {
        nodes: [
          { author: { login: "bob" }, state: "APPROVED" },
          { author: { login: "carol" }, state: "CHANGES_REQUESTED" },
          // A re-requested user who previously commented should surface as
          // pending — the outstanding request wins over the historical review.
          { author: { login: "alice" }, state: "COMMENTED" },
        ],
      },
    });

    expect(detail.reviewers).toEqual([
      { login: "bob", state: "approved", isRequested: false },
      { login: "carol", state: "changes_requested", isRequested: false },
      { login: "alice", state: "pending", isRequested: true },
      { login: "org/frontend", state: "pending", isRequested: true },
    ]);
  });

  it("defaults merge fields off when no repository node is supplied", () => {
    const detail = toPrDetail({
      number: 5,
      state: "OPEN",
      author: { login: "me" },
      reviewThreads: { nodes: [] },
      commits: { nodes: [] },
    });
    expect(detail.mergeMethods).toEqual([]);
    expect(detail.autoMergeEnabled).toBe(false);
    expect(detail.canEnableAutoMerge).toBe(false);
    expect(detail.canDisableAutoMerge).toBe(false);
  });

  it("merges a PR with the chosen method after resolving its node id", async () => {
    const bodies: Array<Record<string, any>> = [];
    const capturing = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ data: { repository: { pullRequest: { id: "PR_node1" } } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", capturing);
    await gh.mergePullRequest("o", "r", 3, "SQUASH");
    // First call resolves the node id; second runs the merge mutation.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.query).toContain("mergePullRequest");
    expect(bodies[1]!.variables).toEqual({ id: "PR_node1", method: "SQUASH" });
  });

  it("enables auto-merge with the chosen method", async () => {
    const bodies: Array<Record<string, any>> = [];
    const capturing = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ data: { repository: { pullRequest: { id: "PR_node2" } } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", capturing);
    await gh.enableAutoMerge("o", "r", 4, "MERGE");
    expect(bodies[1]!.query).toContain("enablePullRequestAutoMerge");
    expect(bodies[1]!.variables).toEqual({ id: "PR_node2", method: "MERGE" });
  });

  it("fetches a single PR's list summary", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/repos/o/r/pulls/7": {
          number: 7,
          title: "Named directly",
          html_url: "https://github.com/o/r/pull/7",
          user: { login: "them" },
          draft: false,
          state: "open",
          created_at: "2026-07-01",
          updated_at: "2026-07-02",
        },
      }),
    );
    expect(await gh.prSummary("o", "r", 7)).toMatchObject({
      number: 7,
      owner: "o",
      repo: "r",
      author: "them",
      title: "Named directly",
    });
  });

  it("shapes involvement search hits, splitting merged out of the closed state", async () => {
    const gh = new GitHubClient(
      "t",
      fakeFetch({
        "/graphql": {
          data: {
            search: {
              nodes: [
                {
                  number: 3,
                  title: "Merged one",
                  url: "https://github.com/o/r/pull/3",
                  isDraft: false,
                  state: "MERGED",
                  createdAt: "2026-07-01",
                  updatedAt: "2026-07-02",
                  author: { login: "them" },
                  repository: { name: "r", owner: { login: "o" } },
                  reviews: { nodes: [{ state: "COMMENTED" }, { state: "APPROVED" }] },
                },
                // An issue hit: matches no inline fragment, so it arrives empty.
                {},
              ],
            },
          },
        },
      }),
    );
    const items = await gh.searchInvolvement("is:pr commenter:@me", "me");
    expect(items.length).toBe(1);
    expect(items[0]!.merged).toBe(true);
    expect(items[0]!.summary).toMatchObject({ number: 3, owner: "o", repo: "r", state: "closed" });
    expect(items[0]!.myReviewStates).toEqual(["commented", "approved"]);
  });

  it("looks up several PRs in one aliased request, dropping ones that error", async () => {
    const bodies: Array<Record<string, any>> = [];
    const partial = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          data: {
            pr0: {
              pullRequest: {
                number: 1,
                title: "Found",
                url: "https://github.com/o/r/pull/1",
                state: "OPEN",
                createdAt: "2026-07-01",
                updatedAt: "2026-07-01",
                author: { login: "them" },
                repository: { name: "r", owner: { login: "o" } },
                reviews: { nodes: [] },
              },
            },
            pr1: null,
          },
          errors: [{ message: "Could not resolve to a Repository" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", partial);
    const items = await gh.lookupInvolvement(
      [
        { owner: "o", repo: "r", number: 1 },
        { owner: "gone", repo: "r", number: 2 },
      ],
      "me",
    );
    expect(items.map((i) => i.summary.number)).toEqual([1]);
    expect(bodies[0]!.variables).toEqual({
      viewer: "me",
      o0: "o",
      r0: "r",
      n0: 1,
      o1: "gone",
      r1: "r",
      n1: 2,
    });
  });

  it("makes no request when there is nothing to look up", async () => {
    const failing = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    expect(await new GitHubClient("t", failing).lookupInvolvement([], "me")).toEqual([]);
  });

  it("disables auto-merge by node id", async () => {
    const bodies: Array<Record<string, any>> = [];
    const capturing = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ data: { repository: { pullRequest: { id: "PR_node3" } } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const gh = new GitHubClient("t", capturing);
    await gh.disableAutoMerge("o", "r", 5);
    expect(bodies[1]!.query).toContain("disablePullRequestAutoMerge");
    expect(bodies[1]!.variables).toEqual({ id: "PR_node3" });
  });

  describe("fileContent", () => {
    /** Captures the request the client makes and replies with fixed content. */
    function capturingFetch(response: Response) {
      const calls: Array<{ url: string; accept: string }> = [];
      const impl = (async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(url), accept: headers.get("Accept") ?? "" });
        return response.clone();
      }) as unknown as typeof fetch;
      return { calls, impl };
    }

    // The raw media type is what keeps this usable: the JSON form base64-encodes
    // the body and refuses outright above 1 MB.
    it("requests the raw media type at the given commit", async () => {
      const { calls, impl } = capturingFetch(new Response("line one\nline two", { status: 200 }));
      const gh = new GitHubClient("t", impl);
      const content = await gh.fileContent("o", "r", "src/lib/pr/diff.ts", "a".repeat(40));

      expect(content).toBe("line one\nline two");
      expect(calls[0]!.accept).toBe("application/vnd.github.raw");
      expect(calls[0]!.url).toBe(
        `https://api.github.com/repos/o/r/contents/src/lib/pr/diff.ts?ref=${"a".repeat(40)}`,
      );
    });

    // Encoding runs per path segment, so directory separators survive as
    // separators while anything else in a name is escaped.
    it("escapes within segments but keeps the path structure", async () => {
      const { calls, impl } = capturingFetch(new Response("", { status: 200 }));
      const gh = new GitHubClient("t", impl);
      await gh.fileContent("o", "r", "src/my dir/a?b.ts", "a".repeat(40));
      expect(calls[0]!.url).toContain("/contents/src/my%20dir/a%3Fb.ts?ref=");
    });

    // A file the PR adds has no content on the base side. That is an ordinary
    // state, so it resolves to empty instead of failing the whole expansion.
    it("resolves a missing path to empty content", async () => {
      const { impl } = capturingFetch(new Response("Not Found", { status: 404 }));
      const gh = new GitHubClient("t", impl);
      expect(await gh.fileContent("o", "r", "gone.ts", "b".repeat(40))).toBe("");
    });

    it("throws on other upstream failures", async () => {
      const { impl } = capturingFetch(new Response("boom", { status: 500 }));
      const gh = new GitHubClient("t", impl);
      expect(gh.fileContent("o", "r", "a.ts", "c".repeat(40))).rejects.toThrow("500");
    });
  });

  describe("encodeRepoPath", () => {
    /**
     * The escape this refuses: `encodeURIComponent` leaves `.` alone, so `..`
     * survives encoding, and `fetch` resolves dot-segments against the URL
     * before sending. `contents/../../../../user/repos` becomes
     * `api.github.com/user/repos` — an arbitrary authenticated read.
     */
    it("refuses traversal segments", () => {
      for (const path of ["../../../../user/repos", "src/../../x", "..", "a/./b"]) {
        expect(() => encodeRepoPath(path)).toThrow("inside the repository");
      }
    });

    it("encodes within segments and keeps the structure", () => {
      expect(encodeRepoPath("src/my dir/a?b.ts")).toBe("src/my%20dir/a%3Fb.ts");
    });

    it("treats the empty path as the repository root", () => {
      expect(encodeRepoPath("")).toBe("");
    });

    // Leading and doubled slashes would otherwise produce empty segments and a
    // URL that no longer addresses the contents endpoint.
    it("drops empty segments", () => {
      expect(encodeRepoPath("/src//a.ts")).toBe("src/a.ts");
    });

    // Proof the guard is what stands between the client and the escape.
    it("blocks the URL that would otherwise resolve off the contents endpoint", () => {
      const traversed = "https://api.github.com/repos/o/r/contents/../../../../user/repos";
      expect(new URL(traversed).href).toBe("https://api.github.com/user/repos");
      expect(() => encodeRepoPath("../../../../user/repos")).toThrow();
    });
  });

  describe("listDir", () => {
    // The contents endpoint answers with an object for a file and an array for
    // a directory, and only the array is a listing.
    it("returns the entries of a directory", async () => {
      const gh = new GitHubClient(
        "t",
        fakeFetch({
          "/repos/o/r/contents/src": [
            { path: "src/a.ts", type: "file" },
            { path: "src/lib", type: "dir" },
          ],
        }),
      );
      expect(await gh.listDir("o", "r", "src", "a".repeat(40))).toEqual([
        { path: "src/a.ts", type: "file" },
        { path: "src/lib", type: "dir" },
      ]);
    });

    it("treats a path that is a file as having no entries", async () => {
      const gh = new GitHubClient(
        "t",
        fakeFetch({ "/repos/o/r/contents/a.ts": { path: "a.ts", type: "file" } }),
      );
      expect(await gh.listDir("o", "r", "a.ts", "a".repeat(40))).toEqual([]);
    });

    it("treats a missing directory as having no entries", async () => {
      const gh = new GitHubClient("t", fakeFetch({}));
      expect(await gh.listDir("o", "r", "nope", "a".repeat(40))).toEqual([]);
    });

    // The repository root is the empty path, which must not leave a double
    // slash in the URL.
    it("addresses the repository root without an empty path segment", async () => {
      const urls: string[] = [];
      const gh = new GitHubClient("t", (async (url: string) => {
        urls.push(String(url));
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch);
      await gh.listDir("o", "r", "", "a".repeat(40));
      expect(urls[0]).toContain("/repos/o/r/contents?ref=");
    });
  });

  describe("searchCode", () => {
    it("scopes the query to the repository and returns matching fragments", async () => {
      const urls: string[] = [];
      const gh = new GitHubClient("t", (async (url: string) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            items: [{ path: "src/a.ts", text_matches: [{ fragment: "callSite()" }] }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch);

      const hits = await gh.searchCode("o", "r", "callSite");
      expect(hits).toEqual([{ path: "src/a.ts", fragments: ["callSite()"] }]);
      expect(urls[0]).toContain(encodeURIComponent("callSite repo:o/r"));
    });

    it("copes with a hit that carries no fragments", async () => {
      const gh = new GitHubClient(
        "t",
        fakeFetch({ "/search/code": { items: [{ path: "a.ts" }] } }),
      );
      expect(await gh.searchCode("o", "r", "q")).toEqual([{ path: "a.ts", fragments: [] }]);
    });
  });

  it("carries the head commit onto the PR detail", () => {
    const detail = toPrDetail({ number: 7, headRefOid: "d".repeat(40) });
    expect(detail.headSha).toBe("d".repeat(40));
  });

  it("reports an empty commit when the provider omits it", () => {
    expect(toPrDetail({ number: 7 }).headSha).toBe("");
  });
});
