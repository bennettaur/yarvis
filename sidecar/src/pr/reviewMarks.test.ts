import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { AzureDevOpsClient } from "../azure/client.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import {
  latestReviewMark,
  providerMarks,
  type ReviewMarkProvider,
  recordReviewMark,
  storeProviderMarks,
} from "./reviewMarks.ts";
import { createPrRoutes } from "./routes.ts";
import type { PrRef } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const config = (secrets: Config["secrets"]): Config => ({
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets,
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
});

const auth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
const sha = (c: string) => c.repeat(40);
const gh: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const az: PrRef = { provider: "azure", org: "acme", project: "Shop", repo: "web", prId: 1 };

const realFetch = globalThis.fetch;

/** A fetch that answers by URL substring; unmatched requests are a 404. */
function stubFetch(routes: [string, unknown][]) {
  globalThis.fetch = (async (input: string) => {
    const hit = routes.find(([part]) => String(input).includes(part));
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: 200 });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await sql`TRUNCATE pr_review_marks, events, pr_guides RESTART IDENTITY CASCADE`;
  providerMarks.forget();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(async () => {
  await sql.end();
});

const post = (app: Hono | ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: auth, body: JSON.stringify(body) });

describe("marks recorded by the GitHub routes", () => {
  const app = createApp(config({ githubToken: "ghp_test" }));

  it("a review records the head the page was showing", async () => {
    stubFetch([["/pulls/1/reviews", { node_id: "PRR_1", commit_id: sha("c") }]]);
    const res = await post(app, "/api/github/pr/o/r/1/reviews", {
      event: "COMMENT",
      body: "looks fine",
      headSha: sha("a"),
      baseSha: sha("b"),
    });
    expect(res.status).toBe(201);
    expect(await latestReviewMark(db, gh)).toMatchObject({
      headSha: sha("a"),
      baseSha: sha("b"),
      source: "review",
    });
  });

  it("without a head from the page, the commit GitHub reviewed is recorded", async () => {
    stubFetch([["/pulls/1/reviews", { node_id: "PRR_1", commit_id: sha("c") }]]);
    await post(app, "/api/github/pr/o/r/1/reviews", { event: "APPROVE" });
    expect(await latestReviewMark(db, gh)).toMatchObject({ headSha: sha("c"), baseSha: null });
  });

  it("a line comment records a comment mark, falling back to the head GitHub anchored it to", async () => {
    stubFetch([
      ["/pulls/1/comments", {}],
      ["/pulls/1", { head: { sha: sha("d") } }],
    ]);
    const res = await post(app, "/api/github/pr/o/r/1/comments", {
      path: "a.ts",
      line: 3,
      body: "?",
    });
    expect(res.status).toBe(201);
    expect(await latestReviewMark(db, gh)).toMatchObject({ headSha: sha("d"), source: "comment" });
  });

  it("refuses a head that isn't a commit sha", async () => {
    const res = await post(app, "/api/github/pr/o/r/1/reviews", {
      event: "APPROVE",
      headSha: "main",
    });
    expect(res.status).toBe(400);
    expect(await latestReviewMark(db, gh)).toBeNull();
  });
});

describe("marks recorded by the Azure routes", () => {
  const app = createApp(
    config({ azureDevopsToken: "pat", azureDevopsOrgUrl: "https://dev.azure.com/acme" }),
  );
  const azure = [
    ["_apis/connectionData", { authenticatedUser: { id: "me" } }],
    ["/reviewers/me", {}],
    ["/threads", {}],
    [
      "/pullRequests/1",
      {
        lastMergeSourceCommit: { commitId: sha("e") },
        lastMergeTargetCommit: { commitId: sha("f") },
      },
    ],
  ] as [string, unknown][];

  it("a vote records the head the page was showing", async () => {
    stubFetch(azure);
    const res = await post(app, "/api/azure/pr/Shop/web/1/vote", { vote: 10, headSha: sha("a") });
    expect(res.status).toBe(201);
    expect(await latestReviewMark(db, az)).toMatchObject({ headSha: sha("a"), source: "review" });
  });

  it("a comment without a head records Azure's current head", async () => {
    stubFetch(azure);
    const res = await post(app, "/api/azure/pr/Shop/web/1/comments", {
      path: "a.ts",
      line: 2,
      body: "x",
    });
    expect(res.status).toBe(201);
    expect(await latestReviewMark(db, az)).toMatchObject({ headSha: sha("e"), source: "comment" });
  });

  it("resetting a vote records nothing", async () => {
    stubFetch(azure);
    await post(app, "/api/azure/pr/Shop/web/1/vote", { vote: 0, headSha: sha("a") });
    expect(await latestReviewMark(db, az)).toBeNull();
  });
});

describe("provider-derived marks", () => {
  it("are stored once per commit and compete with Yarvis's own by time", async () => {
    const reviews = [
      { headSha: sha("1"), submittedAt: "2026-01-01T00:00:00Z" },
      { headSha: sha("2"), submittedAt: "2026-01-02T00:00:00Z" },
      { headSha: "not-a-sha", submittedAt: "2026-01-03T00:00:00Z" },
    ];
    await storeProviderMarks(db, gh, reviews);
    await storeProviderMarks(db, gh, reviews);
    expect((await sql`select count(*)::int as n from pr_review_marks`)[0]?.n).toBe(2);
    expect(await latestReviewMark(db, gh)).toMatchObject({ headSha: sha("2"), source: "provider" });

    await recordReviewMark(db, { ref: gh, headSha: sha("3"), source: "manual" });
    expect(await latestReviewMark(db, gh)).toMatchObject({ headSha: sha("3"), source: "manual" });
  });

  it("GitHub: the viewer's submitted reviews and their commits, drafts left out", async () => {
    stubFetch([
      [
        "/graphql",
        {
          data: {
            viewer: { login: "me" },
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      state: "APPROVED",
                      submittedAt: "2026-01-01T00:00:00Z",
                      commit: { oid: sha("1") },
                    },
                    { state: "PENDING", submittedAt: null, commit: { oid: sha("2") } },
                  ],
                },
              },
            },
          },
        },
      ],
    ]);
    const client = new GitHubClient("t-viewer-reviews", globalThis.fetch);
    expect(await client.viewerReviews("o", "r", 1)).toEqual([
      { headSha: sha("1"), submittedAt: "2026-01-01T00:00:00Z" },
    ]);
  });

  it("GitHub: compare says how far the head moved, and 404 means the commit is gone", async () => {
    stubFetch([[`/compare/${sha("1")}...${sha("2")}`, { status: "ahead", ahead_by: 3 }]]);
    const client = new GitHubClient("t", globalThis.fetch);
    expect(await client.commitsSince("o", "r", sha("1"), sha("2"))).toEqual({
      exists: true,
      commits: 3,
      rewritten: false,
    });
    expect(await client.commitsSince("o", "r", sha("9"), sha("2"))).toEqual({
      exists: false,
      commits: null,
      rewritten: true,
    });
  });

  it("Azure: a vote is matched to the push it followed", async () => {
    stubFetch([
      ["_apis/connectionData", { authenticatedUser: { id: "me" } }],
      [
        "/threads",
        {
          value: [
            {
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "10" },
              },
              comments: [{ author: { id: "me" }, publishedDate: "2026-01-02T12:00:00Z" }],
            },
            {
              properties: {
                CodeReviewThreadType: { $value: "VoteUpdate" },
                CodeReviewVoteResult: { $value: "-5" },
              },
              comments: [{ author: { id: "someone-else" }, publishedDate: "2026-01-03T12:00:00Z" }],
            },
          ],
        },
      ],
      [
        "/iterations",
        {
          value: [
            {
              id: 1,
              createdDate: "2026-01-01T00:00:00Z",
              sourceRefCommit: { commitId: sha("1") },
              commonRefCommit: { commitId: sha("b") },
            },
            { id: 2, createdDate: "2026-01-03T00:00:00Z", sourceRefCommit: { commitId: sha("2") } },
          ],
        },
      ],
    ]);
    const client = new AzureDevOpsClient(
      "pat-votes",
      "https://dev.azure.com/acme",
      globalThis.fetch,
    );
    expect(await client.viewerVotes({ project: "Shop", repo: "web", prId: 1 })).toEqual([
      { headSha: sha("1"), mergeBaseSha: sha("b"), submittedAt: "2026-01-02T12:00:00Z" },
    ]);
  });
});

describe("GET /review-mark", () => {
  let provider: ReviewMarkProvider;
  const app = new Hono().route("/pr", createPrRoutes(config({}), { markProvider: () => provider }));
  const query = (extra = "") =>
    app.request(`/pr/review-mark?provider=github&owner=o&repo=r&number=1${extra}`);

  beforeEach(() => {
    provider = {
      viewerReviews: async () => [{ headSha: sha("1"), submittedAt: "2026-01-01T00:00:00Z" }],
      commitsSince: async () => ({ exists: true, commits: 2, rewritten: false }),
      headSha: async () => sha("2"),
    };
  });

  it("reads reviews made on the provider and says how far the PR has moved", async () => {
    const res = await query(`&head=${sha("2")}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      mark: { headSha: sha("1"), source: "provider" },
      headSha: sha("2"),
      since: { commits: 2 },
    });
  });

  it("is up to date when the head is the reviewed commit", async () => {
    const res = await query(`&head=${sha("1")}`);
    expect(await res.json()).toMatchObject({ since: { commits: 0, exists: true } });
  });

  it("answers with no mark, and a failing provider doesn't fail it", async () => {
    provider = {
      viewerReviews: async () => {
        throw new Error("rate limited");
      },
      commitsSince: async () => ({ exists: true, commits: 0, rewritten: false }),
      headSha: async () => null,
    };
    const res = await query();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mark: null, headSha: null, since: null });
  });

  it("refuses a head that isn't a sha", async () => {
    expect((await query("&head=main")).status).toBe(400);
  });
});
