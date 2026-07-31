import { beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { listAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { listEvents } from "../events/service.ts";
import { saveGuide } from "./guides.ts";
import type { PrRef } from "./types.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-root",
  secrets: {},
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };
const refQuery = "provider=github&owner=o&repo=r&number=1";

const steps = [
  { path: "src/api.ts", startLine: 1, endLine: 10, explanation: "the request arrives here" },
  { path: "src/db.ts", startLine: 5, endLine: 9, explanation: "and is finally written here" },
];

beforeEach(async () => {
  await sql`TRUNCATE pr_guides`;
  await sql`TRUNCATE attention_items`;
  await sql`TRUNCATE events`;
});

describe("GET /api/pr/guide", () => {
  it("reports no guide for a pull request that has none", async () => {
    const res = await app.request(`/api/pr/guide?${refQuery}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ guide: null });
  });

  it("returns a stored guide with its steps and progress", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps });
    const res = await app.request(`/api/pr/guide?${refQuery}`, { headers: auth });
    const body = (await res.json()) as any;
    expect(body.guide).toMatchObject({ headSha: "a".repeat(40), currentStep: 0 });
    expect(body.guide.steps).toHaveLength(2);
  });

  // Without a configured provider the head can't be checked, and a guide that
  // can't be checked is reported as it stands rather than failing the read.
  it("does not fail the read when staleness cannot be checked", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps });
    const res = await app.request(`/api/pr/guide?${refQuery}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).guide.stale).toBe(false);
  });

  it("records that the guide was looked at", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps });
    await app.request(`/api/pr/guide?${refQuery}`, { headers: auth });
    // The event write is fire-and-forget, so give it a moment to land.
    await new Promise((r) => setTimeout(r, 50));
    const events = await listEvents(db, { type: "pr.guide.viewed" });
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ref: "gh:o/r/1" });
  });

  it("rejects a ref that is not a valid identity", async () => {
    const res = await app.request("/api/pr/guide?provider=github&owner=&repo=r&number=1", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/pr/guide/progress", () => {
  beforeEach(async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps, title: "Add ordering" });
  });

  it("records progress and clamps it to the guide", async () => {
    const res = await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ref, step: 99 }),
    });
    expect(await res.json()).toEqual({ currentStep: 1 });
  });

  it("reports no guide rather than silently creating one", async () => {
    const res = await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({
        ref: { provider: "github", owner: "o", repo: "r", number: 99 },
        step: 0,
      }),
    });
    expect(res.status).toBe(404);
  });

  // An in-progress review is high signal about what the user is working on.
  it("raises an attention item naming the current step", async () => {
    await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ref, step: 0 }),
    });
    const items = await listAttention(db, { status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: "Reviewing Add ordering",
      body: "Step 1 of 2 · src/api.ts",
      navTarget: { type: "pr", owner: "o", repo: "r", number: 1 },
    });
  });

  // Reaching the end means the review is no longer in progress; leaving the
  // item pending would show finished work as outstanding.
  it("resolves the attention item at the last step", async () => {
    await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ref, step: 0 }),
    });
    await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ref, step: 1 }),
    });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(0);
  });

  // Advancing repeatedly must update the one live item, not stack a new one.
  it("keeps a single item as the reviewer moves through the guide", async () => {
    const longer = [
      ...steps,
      { path: "src/z.ts", startLine: null, endLine: null, explanation: "x" },
    ];
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps: longer, title: "Add ordering" });
    for (const step of [0, 1]) {
      await app.request("/api/pr/guide/progress", {
        method: "PATCH",
        headers: jsonAuth,
        body: JSON.stringify({ ref, step }),
      });
    }
    const items = await listAttention(db, { status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]!.body).toBe("Step 2 of 3 · src/db.ts");
  });
});

describe("DELETE /api/pr/guide", () => {
  it("removes the guide and clears its attention item", async () => {
    await saveGuide(db, { ref, headSha: "a".repeat(40), steps, title: "t" });
    await app.request("/api/pr/guide/progress", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ref, step: 0 }),
    });
    const res = await app.request(`/api/pr/guide?${refQuery}`, { method: "DELETE", headers: auth });
    expect(await res.json()).toEqual({ deleted: true });
    expect(await listAttention(db, { status: "pending" })).toHaveLength(0);
  });
});

describe("POST /api/pr/guide", () => {
  // The org comes from configuration, not the request, so a ref naming a
  // different one must not send the PAT at a host we did not configure.
  it("refuses an azure ref from an organization we are not configured for", async () => {
    const res = await app.request("/api/pr/guide", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        ref: { provider: "azure", org: "someone-else", project: "P", repo: "r", prId: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a ref with a path-traversing project name", async () => {
    const res = await app.request("/api/pr/guide", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        ref: { provider: "azure", org: "acme", project: "../etc", repo: "r", prId: 1 },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("reports a missing provider token rather than attempting the run", async () => {
    const res = await app.request("/api/pr/guide", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ ref }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("github token");
  });
});
