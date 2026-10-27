import { describe, expect, it } from "bun:test";
import {
  AzureDevOpsClient,
  isAllowedAzureOrgUrl,
  mapPolicyEvaluation,
  mapReviewer,
  summarizeReviewDecision,
} from "./client.ts";

const ORG = "https://dev.azure.com/acme";

/**
 * Routes requests by testing each predicate against the URL in order, returning
 * the first match. Mirrors the GitHub client's fake-fetch helper but matches on
 * substrings since Azure URLs carry query parameters.
 */
function fakeFetch(
  routes: { match: (url: string) => boolean; body: unknown; status?: number }[],
): typeof fetch {
  return (async (url: string) => {
    const route = routes.find((r) => r.match(String(url)));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
}

describe("mapPolicyEvaluation", () => {
  const cases: [string, { status: string; conclusion: string | null } | null][] = [
    ["approved", { status: "COMPLETED", conclusion: "SUCCESS" }],
    ["rejected", { status: "COMPLETED", conclusion: "FAILURE" }],
    ["queued", { status: "IN_PROGRESS", conclusion: null }],
    ["running", { status: "IN_PROGRESS", conclusion: null }],
    ["notApplicable", null],
  ];
  for (const [status, expected] of cases) {
    it(`maps ${status}`, () => {
      const item = mapPolicyEvaluation({
        status,
        configuration: { type: { displayName: "Build" } },
      });
      if (expected === null) {
        expect(item).toBeNull();
      } else {
        expect(item).toMatchObject({ name: "Build", ...expected });
      }
    });
  }
});

describe("mapReviewer", () => {
  it.each([
    [10, "approved", false],
    [5, "approved", false],
    [-10, "changes_requested", false],
    [-5, "changes_requested", false],
    [0, "pending", true],
    [undefined, "pending", true],
  ] as const)("maps vote %p to %s (requested=%s)", (vote, state, isRequested) => {
    const reviewer = mapReviewer({ displayName: "Alex", vote });
    expect(reviewer.state).toBe(state);
    expect(reviewer.isRequested).toBe(isRequested);
    expect(reviewer.login).toBe("Alex");
  });
});

describe("mapReviewer teams", () => {
  it("marks a group reviewer as a team", () => {
    expect(mapReviewer({ displayName: "[Shop]\\Web Team", isContainer: true }).isTeam).toBe(true);
    expect(mapReviewer({ displayName: "Alex" }).isTeam).toBe(false);
  });
});

describe("prCiChecks", () => {
  it("keeps the build and status policies and drops the reviewer ones", async () => {
    let policyUrl = "";
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => {
            policyUrl = u;
            return u.includes("/policy/evaluations");
          },
          body: {
            value: [
              {
                status: "rejected",
                configuration: {
                  type: { id: "0609b952-1397-4640-95ec-e00a01b2c241", displayName: "Build" },
                },
              },
              {
                status: "running",
                configuration: {
                  type: { id: "status-type", displayName: "Status" },
                  settings: { statusName: "sonar" },
                },
              },
              // Rejected until someone approves; that is review, not CI.
              {
                status: "rejected",
                configuration: {
                  type: { id: "reviewers-type", displayName: "Minimum number of reviewers" },
                },
              },
            ],
          },
        },
      ]),
    );
    const checks = await az.prCiChecks("Shop", "proj-1", 7);
    expect(policyUrl).toContain(encodeURIComponent("vstfs:///CodeReview/CodeReviewId/proj-1/7"));
    expect(checks).toEqual([
      { name: "Build", status: "COMPLETED", conclusion: "FAILURE", url: null },
      { name: "Status", status: "IN_PROGRESS", conclusion: null, url: null },
    ]);
  });

  it("asks nothing without a project id", async () => {
    let asked = false;
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: () => {
            asked = true;
            return true;
          },
          body: { value: [] },
        },
      ]),
    );
    expect(await az.prCiChecks("Shop", "", 7)).toEqual([]);
    expect(asked).toBe(false);
  });
});

describe("summarizeReviewDecision", () => {
  it("lets one blocking vote outrank any number of approvals", () => {
    expect(
      summarizeReviewDecision([
        { displayName: "Ada", vote: 10 },
        { displayName: "Grace", vote: 5 },
        { displayName: "Alan", vote: -10 },
      ]),
    ).toBe("changes_requested");
  });

  it("treats waiting-for-author as blocking, matching mapReviewerVote", () => {
    expect(summarizeReviewDecision([{ displayName: "Ada", vote: -5 }])).toBe("changes_requested");
  });

  it("counts approved-with-suggestions as an approval", () => {
    expect(summarizeReviewDecision([{ displayName: "Ada", vote: 5 }])).toBe("approved");
  });

  it("reports reviewers who haven't voted, or none at all, as awaiting review", () => {
    expect(summarizeReviewDecision([{ displayName: "Ada", vote: 0 }, { displayName: "Bo" }])).toBe(
      "review_required",
    );
    expect(summarizeReviewDecision([])).toBe("review_required");
  });
});

describe("azure client", () => {
  it("reads one PR as a summary", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("/repositories/web/pullRequests/7"),
          body: {
            pullRequestId: 7,
            title: "Fix bug",
            status: "active",
            isDraft: true,
            creationDate: "2026-06-01",
            createdBy: { displayName: "Them" },
            repository: { name: "web", project: { name: "Shop", id: "p1" } },
          },
        },
      ]),
    );
    expect(await az.prSummary({ project: "Shop", repo: "web", prId: 7 })).toMatchObject({
      prId: 7,
      title: "Fix bug",
      org: "acme",
      project: "Shop",
      repo: "web",
      author: "Them",
      draft: true,
      url: `${ORG}/Shop/_git/web/pullrequest/7`,
    });
  });

  it("maps PR search items to summaries", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("connectionData"),
          body: { authenticatedUser: { id: "user-1", providerDisplayName: "Me" } },
        },
        {
          match: (u) => u.includes("/_apis/git/pullrequests"),
          body: {
            value: [
              {
                pullRequestId: 42,
                title: "Add feature",
                status: "active",
                isDraft: false,
                creationDate: "2026-06-01",
                createdBy: { displayName: "Me" },
                repository: {
                  name: "web",
                  webUrl: "https://dev.azure.com/acme/Shop/_git/web",
                  project: { name: "Shop", id: "p1" },
                },
              },
            ],
          },
        },
      ]),
    );
    const prs = await az.search("mine");
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      prId: 42,
      title: "Add feature",
      org: "acme",
      project: "Shop",
      repo: "web",
      author: "Me",
      draft: false,
    });
  });

  it("derives the org from a legacy visualstudio.com org URL's subdomain", async () => {
    // The org lives in the subdomain, not a path segment — the summary's `org`
    // must be "myorg", matching what parseRepoRemote extracts from a clone URL
    // so the poller's cross-org comparison lines up.
    const az = new AzureDevOpsClient(
      "pat",
      "https://myorg.visualstudio.com",
      fakeFetch([
        {
          match: (u) => u.includes("connectionData"),
          body: { authenticatedUser: { id: "user-1" } },
        },
        {
          match: (u) => u.includes("/_apis/git/pullrequests"),
          body: {
            value: [{ pullRequestId: 1, status: "active", repository: { name: "web" } }],
          },
        },
      ]),
    );
    const prs = await az.search("mine");
    expect(prs[0]?.org).toBe("myorg");
  });

  it("finds a PR by its source branch, scoped to the repo", async () => {
    let requestedUrl = "";
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => {
            requestedUrl = String(u);
            return u.includes("/repositories/web/pullrequests");
          },
          body: {
            value: [
              {
                pullRequestId: 42,
                status: "active",
                isDraft: true,
                mergeStatus: "succeeded",
                repository: {
                  name: "web",
                  webUrl: "https://dev.azure.com/acme/Shop/_git/web",
                  project: { name: "Shop" },
                },
              },
            ],
          },
        },
      ]),
    );
    const pr = await az.findPrByBranch("Shop", "web", "feature/x");
    expect(requestedUrl).toContain("searchCriteria.sourceRefName=refs%2Fheads%2Ffeature%2Fx");
    expect(requestedUrl).toContain("searchCriteria.status=all");
    expect(pr).toEqual({
      number: 42,
      url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/42",
      draft: true,
      state: "open",
      mergeable: "MERGEABLE",
      reviewDecision: "review_required",
      projectId: "",
    });
  });

  it("returns null when no PR exists for the branch", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        { match: (u) => u.includes("/repositories/web/pullrequests"), body: { value: [] } },
      ]),
    );
    expect(await az.findPrByBranch("Shop", "web", "feature/x")).toBeNull();
  });

  it("maps a completed PR to merged state", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("/repositories/web/pullrequests"),
          body: {
            value: [
              {
                pullRequestId: 9,
                status: "completed",
                repository: { name: "web", project: { name: "Shop" } },
              },
            ],
          },
        },
      ]),
    );
    expect((await az.findPrByBranch("Shop", "web", "b"))?.state).toBe("merged");
  });

  it("searches by reviewer for the review scope", async () => {
    let reviewerQueried = false;
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("connectionData"),
          body: { authenticatedUser: { id: "user-1", providerDisplayName: "Me" } },
        },
        {
          match: (u) => {
            if (u.includes("reviewerId=user-1")) reviewerQueried = true;
            return u.includes("/_apis/git/pullrequests");
          },
          body: { value: [] },
        },
      ]),
    );
    await az.search("review");
    expect(reviewerQueried).toBe(true);
  });

  it("resolves the viewer from connectionData without an api-version", async () => {
    let connectionUrl = "";
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => {
            if (u.includes("connectionData")) connectionUrl = u;
            return u.includes("connectionData");
          },
          body: { authenticatedUser: { id: "user-1", providerDisplayName: "Me" } },
        },
      ]),
    );
    const viewer = await az.viewer();
    expect(viewer).toEqual({ login: "Me", id: "user-1" });
    // connectionData 400s when sent an api-version, so it must be requested bare.
    expect(connectionUrl).not.toContain("api-version");
  });

  it("caches the viewer id across client instances for the same PAT", async () => {
    let connectionCalls = 0;
    // A distinct token keeps this case isolated from the shared-"pat" cache key.
    const fetchImpl = fakeFetch([
      {
        match: (u) => {
          if (u.includes("connectionData")) connectionCalls++;
          return u.includes("connectionData");
        },
        body: { authenticatedUser: { id: "user-1", providerDisplayName: "Me" } },
      },
      { match: (u) => u.includes("/_apis/git/pullrequests"), body: { value: [] } },
    ]);
    // The client is built fresh per request, so a second instance must reuse the
    // id the first one resolved rather than calling connectionData again.
    await new AzureDevOpsClient("pat-cache", ORG, fetchImpl).search("mine");
    await new AzureDevOpsClient("pat-cache", ORG, fetchImpl).search("review");
    expect(connectionCalls).toBe(1);
  });

  it("builds PR detail with mapped checks and threads", async () => {
    let policyUrl = "";
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => /\/pullRequests\/7$/.test(u.split("?")[0]!),
          body: {
            pullRequestId: 7,
            title: "Fix",
            description: "body",
            status: "active",
            isDraft: false,
            createdBy: { displayName: "Me" },
            sourceRefName: "refs/heads/feature",
            targetRefName: "refs/heads/main",
            mergeStatus: "succeeded",
            repository: { name: "web", project: { name: "Shop", id: "p1" } },
          },
        },
        {
          match: (u) => {
            if (u.includes("/policy/evaluations")) policyUrl = u;
            return u.includes("/policy/evaluations");
          },
          body: {
            value: [{ status: "approved", configuration: { type: { displayName: "Build" } } }],
          },
        },
        {
          match: (u) => u.includes("/threads"),
          body: {
            value: [
              {
                status: "active",
                threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 12 } },
                comments: [
                  {
                    author: { displayName: "Rev" },
                    content: "nit",
                    publishedDate: "2026-06-02",
                    commentType: "text",
                  },
                ],
              },
              { status: "closed", comments: [{ commentType: "system", content: "voted" }] },
            ],
          },
        },
      ]),
    );
    const detail = await az.prDetail({ project: "Shop", repo: "web", prId: 7 });
    expect(detail).toMatchObject({
      number: 7,
      baseRef: "main",
      headRef: "feature",
      fromFork: false,
      mergeable: "MERGEABLE",
      // Azure exposes no in-app merge controls, so the fields stay empty/off.
      mergeMethods: [],
      autoMergeEnabled: false,
      canEnableAutoMerge: false,
      canDisableAutoMerge: false,
    });
    expect(detail.checks).toEqual([
      { name: "Build", status: "COMPLETED", conclusion: "SUCCESS", url: null },
    ]);
    // policy/evaluations is preview-only and 400s on the GA version.
    expect(policyUrl).toContain("api-version=7.1-preview.1");
    expect(detail.reviewThreads).toHaveLength(1);
    expect(detail.reviewThreads[0]).toMatchObject({
      path: "src/app.ts",
      line: 12,
      isResolved: false,
    });
  });

  // `forkSource` is present only when the source branch lives in a fork, which
  // is what tells a caller the branch is not on the target repo's remote.
  it("reports a pull request raised from a fork", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => /\/pullRequests\/8$/.test(u.split("?")[0]!),
          body: {
            pullRequestId: 8,
            sourceRefName: "refs/heads/feature",
            targetRefName: "refs/heads/main",
            repository: { name: "web", project: { name: "Shop", id: "p1" } },
            forkSource: { repository: { name: "web-fork" } },
          },
        },
        { match: () => true, body: { value: [] } },
      ]),
    );
    const detail = await az.prDetail({ project: "Shop", repo: "web", prId: 8 });
    expect(detail.fromFork).toBe(true);
  });

  it("lists changed files without patches", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("/iterations/3/changes"),
          body: {
            changeEntries: [
              { item: { path: "/a.ts" }, changeType: "edit" },
              { item: { path: "/b.ts" }, changeType: "add" },
            ],
          },
        },
        { match: (u) => u.includes("/iterations"), body: { value: [{ id: 1 }, { id: 3 }] } },
      ]),
    );
    const files = await az.prFiles({ project: "Shop", repo: "web", prId: 7 });
    expect(files).toEqual([
      { filename: "a.ts", status: "modified", additions: 0, deletions: 0, patch: null },
      { filename: "b.ts", status: "added", additions: 0, deletions: 0, patch: null },
    ]);
  });

  it("builds a single file's diff from base and head content", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => /\/pullRequests\/7$/.test(u.split("?")[0]!),
          body: {
            pullRequestId: 7,
            lastMergeSourceCommit: { commitId: "head" },
            lastMergeTargetCommit: { commitId: "base" },
            repository: { name: "web", project: { name: "Shop", id: "p1" } },
          },
        },
        {
          match: (u) => u.includes("/items") && u.includes("version=base"),
          body: { content: "a\nb\nc\n" },
        },
        {
          match: (u) => u.includes("/items") && u.includes("version=head"),
          body: { content: "a\nB\nc\n" },
        },
      ]),
    );
    const file = await az.prFileDiff({ project: "Shop", repo: "web", prId: 7 }, "/src/app.ts");
    expect(file.filename).toBe("src/app.ts");
    expect(file.status).toBe("modified");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
    expect(file.patch!.startsWith("@@")).toBe(true);
  });

  it("reads a file's full text at a commit", async () => {
    const urls: string[] = [];
    const az = new AzureDevOpsClient("pat", ORG, (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ content: "a\nb\n" }), { status: 200 });
    }) as unknown as typeof fetch);

    const content = await az.fileContent(
      { project: "Shop", repo: "web", prId: 7 },
      "src/app.ts",
      "f".repeat(40),
    );
    expect(content).toBe("a\nb\n");
    // Azure wants a leading slash on the item path; callers pass repo-relative
    // paths, so the client is the one that has to put it back.
    expect(urls[0]).toContain(`path=${encodeURIComponent("/src/app.ts")}`);
    expect(urls[0]).toContain(`version=${"f".repeat(40)}`);
  });

  it("resolves a missing file to empty content", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([{ match: () => true, body: {}, status: 404 }]),
    );
    expect(
      await az.fileContent({ project: "Shop", repo: "web", prId: 7 }, "gone.ts", "a".repeat(40)),
    ).toBe("");
  });

  // Azure includes the directory being listed as the first entry of its own
  // listing, which is not something the caller asked for.
  it("lists a directory without echoing the directory itself", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("/items") && u.includes("recursionLevel=OneLevel"),
          body: {
            value: [
              { path: "/src", isFolder: true },
              { path: "/src/app.ts", isFolder: false },
              { path: "/src/lib", isFolder: true },
            ],
          },
        },
      ]),
    );
    expect(
      await az.listDir({ project: "Shop", repo: "web", prId: 7 }, "src", "a".repeat(40)),
    ).toEqual([
      { path: "src/app.ts", type: "file" },
      { path: "src/lib", type: "dir" },
    ]);
  });

  it("treats a missing directory as having no entries", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([{ match: () => true, body: {}, status: 404 }]),
    );
    expect(
      await az.listDir({ project: "Shop", repo: "web", prId: 7 }, "gone", "a".repeat(40)),
    ).toEqual([]);
  });

  describe("searchCode", () => {
    it("posts to the search host with the repository as a filter", async () => {
      const calls: { url: string; body: any }[] = [];
      const az = new AzureDevOpsClient("pat", ORG, (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ results: [{ path: "/src/app.ts" }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch);

      const hits = await az.searchCode({ project: "Shop", repo: "web", prId: 7 }, "callSite");
      expect(hits).toEqual([{ path: "src/app.ts" }]);
      expect(calls[0]!.url).toContain("almsearch.dev.azure.com/acme/Shop");
      expect(calls[0]!.body.filters).toEqual({ Repository: ["web"] });
    });

    // Code search is an extension an organization may simply not have, so a
    // failure resolves to null rather than ending the agent run.
    it("resolves to null when the search service is unavailable", async () => {
      const az = new AzureDevOpsClient(
        "pat",
        ORG,
        fakeFetch([{ match: () => true, body: {}, status: 404 }]),
      );
      expect(await az.searchCode({ project: "Shop", repo: "web", prId: 7 }, "q")).toBeNull();
    });
  });

  it("carries the head commit onto the PR detail", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => /\/pullRequests\/7$/.test(u.split("?")[0]!),
          body: {
            pullRequestId: 7,
            lastMergeSourceCommit: { commitId: "abc" },
            lastMergeTargetCommit: { commitId: "def" },
            repository: { name: "web", project: { name: "Shop", id: "p1" } },
          },
        },
        { match: () => true, body: { value: [] } },
      ]),
    );
    const detail = await az.prDetail({ project: "Shop", repo: "web", prId: 7 });
    expect(detail.headSha).toBe("abc");
  });

  // The review header's conflict banner reads the detail, not the status.
  it("reports conflicts on the PR detail in the shared vocabulary", async () => {
    const detailFor = async (mergeStatus: string | undefined) => {
      const az = new AzureDevOpsClient(
        "pat",
        ORG,
        fakeFetch([
          {
            match: (u) => /\/pullRequests\/7$/.test(u.split("?")[0]!),
            body: {
              pullRequestId: 7,
              mergeStatus,
              repository: { name: "web", project: { name: "Shop", id: "p1" } },
            },
          },
          { match: () => true, body: { value: [] } },
        ]),
      );
      return az.prDetail({ project: "Shop", repo: "web", prId: 7 });
    };
    const conflicts = await detailFor("conflicts");
    expect(conflicts.mergeable).toBe("CONFLICTING");
    expect(conflicts.hasConflicts).toBe(true);
    expect((await detailFor("succeeded")).hasConflicts).toBe(false);
    expect((await detailFor("queued")).mergeable).toBe("UNKNOWN");
    // A merge a branch policy refused can't merge either, but has nothing to resolve.
    const rejected = await detailFor("rejectedByPolicy");
    expect(rejected.mergeable).toBe("CONFLICTING");
    expect(rejected.hasConflicts).toBe(false);
  });

  it("posts a right-side line comment thread", async () => {
    let posted: any = null;
    const fetchImpl = (async (url: string, init: any) => {
      if (String(url).includes("/threads") && init?.method === "POST") {
        posted = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const az = new AzureDevOpsClient("pat", ORG, fetchImpl);
    await az.postComment(
      { project: "Shop", repo: "web", prId: 7 },
      { path: "src/app.ts", line: 12, body: "hi" },
    );
    expect(posted).toMatchObject({
      status: 1,
      comments: [{ content: "hi", commentType: 1 }],
      threadContext: { filePath: "/src/app.ts", rightFileStart: { line: 12, offset: 1 } },
    });
  });

  it("maps delete and rename change types", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => u.includes("/iterations/1/changes"),
          body: {
            changeEntries: [
              { item: { path: "/gone.ts" }, changeType: "delete" },
              { item: { path: "/moved.ts" }, changeType: "rename" },
            ],
          },
        },
        { match: (u) => u.includes("/iterations"), body: { value: [{ id: 1 }] } },
      ]),
    );
    const files = await az.prFiles({ project: "Shop", repo: "web", prId: 8 });
    expect(files.map((f) => [f.filename, f.status])).toEqual([
      ["gone.ts", "removed"],
      ["moved.ts", "renamed"],
    ]);
  });

  it("maps merge status to the shared mergeable flag", async () => {
    const make = (prId: number, mergeStatus: string | undefined) =>
      new AzureDevOpsClient(
        "pat",
        ORG,
        fakeFetch([
          {
            match: (u) => new RegExp(`/pullRequests/${prId}$`).test(u.split("?")[0]!),
            body: { pullRequestId: prId, mergeStatus, repository: { project: { id: "p1" } } },
          },
        ]),
      );
    expect(
      (await make(20, "succeeded").prStatus({ project: "Shop", repo: "web", prId: 20 })).mergeable,
    ).toBe(true);
    expect(
      (await make(21, "conflicts").prStatus({ project: "Shop", repo: "web", prId: 21 })).mergeable,
    ).toBe(false);
    expect(
      (await make(22, undefined).prStatus({ project: "Shop", repo: "web", prId: 22 })).mergeable,
    ).toBeNull();
  });

  it("maps a resolved thread and falls back to the left-file line", async () => {
    const az = new AzureDevOpsClient(
      "pat",
      ORG,
      fakeFetch([
        {
          match: (u) => /\/pullRequests\/30$/.test(u.split("?")[0]!),
          body: {
            pullRequestId: 30,
            mergeStatus: "succeeded",
            repository: {
              project: { id: "p1" },
              webUrl: "https://dev.azure.com/acme/Shop/_git/web",
            },
          },
        },
        { match: (u) => u.includes("/policy/evaluations"), body: { value: [] } },
        {
          match: (u) => u.includes("/threads"),
          body: {
            value: [
              {
                id: 3,
                status: "fixed",
                threadContext: { filePath: "/src/old.ts", leftFileStart: { line: 5 } },
                comments: [
                  {
                    id: 1,
                    author: { displayName: "Rev" },
                    content: "removed here",
                    commentType: "text",
                  },
                ],
              },
            ],
          },
        },
      ]),
    );
    const detail = await az.prDetail({ project: "Shop", repo: "web", prId: 30 });
    expect(detail.reviewThreads).toEqual([
      {
        id: "3",
        path: "src/old.ts",
        line: 5,
        side: "LEFT",
        isResolved: true,
        isOutdated: false,
        canReply: true,
        canResolve: true,
        canUnresolve: true,
        comments: [
          {
            id: "1",
            author: "Rev",
            body: "removed here",
            createdAt: "",
            url: "https://dev.azure.com/acme/Shop/_git/web/pullrequest/30?discussionId=3",
          },
        ],
      },
    ]);
  });

  describe("comment threads", () => {
    const ref = { project: "Shop", repo: "web", prId: 7 };

    /** Detail for PR 7 whose threads endpoint answers `threads`. */
    function withThreads(threads: unknown[]) {
      return new AzureDevOpsClient(
        "pat",
        ORG,
        fakeFetch([
          {
            match: (u) => /\/pullRequests\/7$/.test(u.split("?")[0]!),
            body: { pullRequestId: 7, repository: { project: { id: "p1" } } },
          },
          { match: (u) => u.includes("/policy/evaluations"), body: { value: [] } },
          { match: (u) => u.includes("/threads"), body: { value: threads } },
        ]),
      );
    }

    const comment = { id: 1, author: { displayName: "Rev" }, content: "hm", commentType: "text" };

    it("maps a range on the right side to its last line plus a start line", async () => {
      const az = withThreads([
        {
          id: 9,
          status: "active",
          threadContext: {
            filePath: "/a.ts",
            rightFileStart: { line: 10, offset: 1 },
            rightFileEnd: { line: 14, offset: 1 },
          },
          comments: [comment],
        },
      ]);
      const [thread] = (await az.prDetail(ref)).reviewThreads;
      expect(thread).toMatchObject({
        id: "9",
        line: 14,
        startLine: 10,
        startSide: "RIGHT",
        side: "RIGHT",
      });
    });

    it("reads a range on the left side", async () => {
      const az = withThreads([
        {
          id: 9,
          status: "active",
          threadContext: {
            filePath: "/a.ts",
            leftFileStart: { line: 3, offset: 1 },
            leftFileEnd: { line: 6, offset: 1 },
          },
          comments: [comment],
        },
      ]);
      const [thread] = (await az.prDetail(ref)).reviewThreads;
      expect(thread).toMatchObject({ line: 6, startLine: 3, startSide: "LEFT", side: "LEFT" });
    });

    // Every write addresses a thread by id, so one Azure left the id off can
    // be read but not answered or resolved.
    it("makes a thread without an id read-only", async () => {
      const az = withThreads([{ status: "active", comments: [comment] }]);
      const [thread] = (await az.prDetail(ref)).reviewThreads;
      expect(thread).toMatchObject({
        id: "",
        canReply: false,
        canResolve: false,
        canUnresolve: false,
      });
      expect(thread!.comments[0]!.url).toBeUndefined();
    });

    it("offers no reply when the first comment has no id to answer", async () => {
      const az = withThreads([
        { id: 4, status: "active", comments: [{ ...comment, id: undefined }] },
      ]);
      const [thread] = (await az.prDetail(ref)).reviewThreads;
      expect(thread).toMatchObject({ canReply: false, canResolve: true });
    });

    it("counts won't-fix as resolved and pending as open", async () => {
      const az = withThreads([
        { id: 1, status: "wontFix", comments: [comment] },
        { id: 2, status: "pending", comments: [comment] },
        { id: 3, comments: [comment] },
      ]);
      const threads = (await az.prDetail(ref)).reviewThreads;
      expect(threads.map((t) => t.isResolved)).toEqual([true, false, false]);
    });

    it("drops deleted threads and deleted comments", async () => {
      const az = withThreads([
        { id: 1, status: "active", isDeleted: true, comments: [comment] },
        {
          id: 2,
          status: "active",
          comments: [comment, { ...comment, id: 2, content: "gone", isDeleted: true }],
        },
      ]);
      const threads = (await az.prDetail(ref)).reviewThreads;
      expect(threads.map((t) => t.id)).toEqual(["2"]);
      expect(threads[0]!.comments.map((c) => c.body)).toEqual(["hm"]);
    });

    /** A fetch that records every write and answers it with `{}`. */
    function recording() {
      const calls: { url: string; method: string; body: any }[] = [];
      const fetchImpl = (async (url: string, init: any) => {
        calls.push({ url: String(url), method: init?.method, body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      return { calls, az: new AzureDevOpsClient("pat", ORG, fetchImpl) };
    }

    it("posts a left-side range", async () => {
      const { calls, az } = recording();
      await az.postComment(ref, { path: "a.ts", line: 8, startLine: 6, side: "LEFT", body: "x" });
      expect(calls[0]!.body.threadContext).toEqual({
        filePath: "/a.ts",
        leftFileStart: { line: 6, offset: 1 },
        leftFileEnd: { line: 8, offset: 1 },
      });
    });

    it("replies to a thread under its first comment", async () => {
      const { calls, az } = recording();
      await az.replyToThread(ref, 9, "agreed");
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toContain("/pullRequests/7/threads/9/comments?api-version=7.1");
      expect(calls[0]!.body).toEqual({ content: "agreed", parentCommentId: 1, commentType: 1 });
    });

    it("replies under the comment the caller names", async () => {
      const { calls, az } = recording();
      await az.replyToThread(ref, 9, "agreed", 4);
      expect(calls[0]!.body.parentCommentId).toBe(4);
    });

    it("resolves a thread as fixed and reactivates it as active", async () => {
      const { calls, az } = recording();
      await az.setThreadResolved(ref, 9, true);
      await az.setThreadResolved(ref, 9, false);
      expect(calls.map((c) => [c.method, c.body.status])).toEqual([
        ["PATCH", 2],
        ["PATCH", 1],
      ]);
      expect(calls[0]!.url).toContain("/pullRequests/7/threads/9?api-version=7.1");
    });

    it("reports a failed write with its status", async () => {
      const az = new AzureDevOpsClient(
        "pat",
        ORG,
        (async () => new Response("no", { status: 403 })) as unknown as typeof fetch,
      );
      await expect(az.setThreadResolved(ref, 9, true)).rejects.toThrow("-> 403");
    });
  });
});

describe("isAllowedAzureOrgUrl", () => {
  it("accepts https dev.azure.com and *.visualstudio.com", () => {
    expect(isAllowedAzureOrgUrl("https://dev.azure.com/acme")).toBe(true);
    expect(isAllowedAzureOrgUrl("https://acme.visualstudio.com")).toBe(true);
  });

  it("rejects non-https and non-Azure hosts", () => {
    expect(isAllowedAzureOrgUrl("http://dev.azure.com/acme")).toBe(false);
    expect(isAllowedAzureOrgUrl("https://evil.example.com/acme")).toBe(false);
    expect(isAllowedAzureOrgUrl("not a url")).toBe(false);
  });
});
