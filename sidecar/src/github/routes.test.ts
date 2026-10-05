import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { listEvents } from "../events/service.ts";
import { recordReviewContributions } from "../jobs/githubReviewSync.ts";
import { reviewExternalId } from "./client.ts";

/**
 * Config wired with a GitHub token + a database URL so the GitHub routes run
 * their request validation. The bad inputs below are all rejected before any
 * GitHub or database access, so no real services are needed.
 */
function appWith(
  secrets: Config["secrets"],
  databaseUrl = "postgres://localhost/unused",
): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets,
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const configured = appWith({ githubToken: "ghp_test" });
const auth = { Authorization: "Bearer test-token" };

describe("github review submission validation", () => {
  it("rejects REQUEST_CHANGES without a body with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "REQUEST_CHANGES" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("request changes");
  });

  it("rejects REQUEST_CHANGES with a whitespace-only body with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "REQUEST_CHANGES", body: "   \n  " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown event value with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "BURN_IT_DOWN" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric PR number with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/abc/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "APPROVE" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github viewed-files validation", () => {
  it("rejects an empty path with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/viewed", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "", viewed: true }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean viewed flag with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/viewed", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "src/app.ts", viewed: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github merge validation", () => {
  it("rejects an unknown merge method with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/merge", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "FAST_FORWARD" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric PR number on auto-merge with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/abc/auto-merge", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "SQUASH" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric PR number on cancel-auto-merge with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/abc/auto-merge", {
      method: "DELETE",
      headers: { ...auth },
    });
    expect(res.status).toBe(400);
  });
});

describe("github pr config validation", () => {
  const put = (body: unknown) =>
    configured.request("/api/github/config", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("rejects an empty review query with 400", async () => {
    expect((await put({ reviewQuery: "   ", reviewingLookbackDays: 30 })).status).toBe(400);
  });

  it("rejects a lookback outside the supported range with 400", async () => {
    expect((await put({ reviewQuery: "is:pr", reviewingLookbackDays: 0 })).status).toBe(400);
    expect((await put({ reviewQuery: "is:pr", reviewingLookbackDays: 400 })).status).toBe(400);
    expect((await put({ reviewQuery: "is:pr", reviewingLookbackDays: 1.5 })).status).toBe(400);
  });

  it("rejects a body missing the lookback with 400", async () => {
    expect((await put({ reviewQuery: "is:pr" })).status).toBe(400);
  });
});

describe("github not-configured handling", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/github/viewer");
    expect(res.status).toBe(401);
  });

  it("returns 400 when no GitHub token is configured", async () => {
    const app = appWith({});
    const res = await app.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "APPROVE" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github review submission logging", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const db = drizzle(sql, { schema });
  const app = appWith({ githubToken: "ghp_test" }, url);
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await sql`TRUNCATE events, pr_guides RESTART IDENTITY CASCADE`;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  afterAll(async () => {
    await sql.end();
  });

  function stubSubmit(reply: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(reply), { status: 200 })) as unknown as typeof fetch;
  }

  /** The event is emitted after the response is sent, so wait for it to land. */
  async function loggedEvents() {
    for (let i = 0; i < 50; i++) {
      const rows = await listEvents(db);
      if (rows.length > 0) return rows;
      await Bun.sleep(10);
    }
    return [];
  }

  const approve = () =>
    app.request("/api/github/pr/o/r/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "APPROVE" }),
    });

  it("logs the review under its GitHub id, which the sync then recognises", async () => {
    stubSubmit({ id: 9, node_id: "PRR_9" });
    expect((await approve()).status).toBe(201);
    const [event] = await loggedEvents();
    expect(event).toMatchObject({ type: "pr.approved", externalId: reviewExternalId("PRR_9") });

    // Hours away from the in-app event, so only the id can match it.
    const synced = await recordReviewContributions(
      db,
      [
        {
          reviewId: "PRR_9",
          state: "approved",
          submittedAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
          owner: "o",
          repo: "r",
          number: 1,
        },
      ],
      {
        from: new Date(Date.now() - 60 * 60 * 1000),
        to: new Date(Date.now() + 4 * 60 * 60 * 1000),
      },
    );
    expect(synced).toBe(0);
  });

  it("still logs the review when GitHub's reply has no node id", async () => {
    stubSubmit({});
    expect((await approve()).status).toBe(201);
    const [event] = await loggedEvents();
    expect(event).toMatchObject({ type: "pr.approved", externalId: null });
  });
});
