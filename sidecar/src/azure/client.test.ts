import { describe, expect, it } from "bun:test";
import { AzureDevOpsClient, isAllowedAzureOrgUrl, mapPolicyEvaluation } from "./client.ts";

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

describe("azure client", () => {
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
      mergeable: "MERGEABLE",
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
            repository: { project: { id: "p1" } },
          },
        },
        { match: (u) => u.includes("/policy/evaluations"), body: { value: [] } },
        {
          match: (u) => u.includes("/threads"),
          body: {
            value: [
              {
                status: "fixed",
                threadContext: { filePath: "/src/old.ts", leftFileStart: { line: 5 } },
                comments: [
                  { author: { displayName: "Rev" }, content: "removed here", commentType: "text" },
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
        path: "src/old.ts",
        line: 5,
        isResolved: true,
        comments: [{ author: "Rev", body: "removed here", createdAt: "" }],
      },
    ]);
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
