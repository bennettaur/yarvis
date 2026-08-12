import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);

const bearer = { Authorization: "Bearer test-token", "Content-Type": "application/json" };
const ingestAuth = {
  Authorization: "Bearer test-attention-token",
  "Content-Type": "application/json",
};

/** A workspace row the FK on attention_items.workspace_id can reference. */
async function seedWorkspace(id: string, name: string) {
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${id}, ${name}, ${name}, 'active', '/tmp/ws')`;
}

beforeEach(async () => {
  await sql`TRUNCATE attention_items, workspaces RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const workspaceId = "11111111-1111-1111-1111-111111111111";

describe("attention ingest route", () => {
  it("creates an item with the scoped attention token and titles it from the workspace", async () => {
    await seedWorkspace(workspaceId, "Fix the API");
    const res = await app.request("/ingest/attention", {
      method: "POST",
      headers: ingestAuth,
      body: JSON.stringify({
        workspaceId,
        sessionKey: `ws-claude:${workspaceId}`,
        kind: "permission",
      }),
    });
    expect(res.status).toBe(201);

    const list = await app.request("/api/attention?status=pending", { headers: bearer });
    const rows = (await list.json()) as { title: string; kind: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Fix the API");
    expect(rows[0]!.kind).toBe("permission");
  });

  it("rejects the ingest endpoint without the attention token", async () => {
    const noAuth = await app.request("/ingest/attention", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, sessionKey: "ws-claude:x", kind: "idle" }),
    });
    expect(noAuth.status).toBe(401);

    // The full-access bearer must NOT be accepted here — the point of the scope.
    const wrongToken = await app.request("/ingest/attention", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ workspaceId, sessionKey: "ws-claude:x", kind: "idle" }),
    });
    expect(wrongToken.status).toBe(401);
  });

  it("requires the main bearer to read the stream list", async () => {
    const res = await app.request("/api/attention");
    expect(res.status).toBe(401);
  });

  it("never lets the ingest token reach the read/mutate routes", async () => {
    // The token now rides in every navigable PTY, so "create-only" is the whole
    // reason that is safe — pin it from the other direction too.
    const attentionOnly = { Authorization: "Bearer test-attention-token" };
    expect((await app.request("/api/attention", { headers: attentionOnly })).status).toBe(401);

    const cleared = await app.request("/api/attention/clear", {
      method: "POST",
      headers: { ...attentionOnly, "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, status: "read" }),
    });
    expect(cleared.status).toBe(401);

    const patched = await app.request(`/api/attention/${workspaceId}`, {
      method: "PATCH",
      headers: { ...attentionOnly, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "read" }),
    });
    expect(patched.status).toBe(401);
  });

  it("rejects a workspace id that isn't a uuid rather than failing at the database", async () => {
    const res = await app.request("/ingest/attention", {
      method: "POST",
      headers: ingestAuth,
      body: JSON.stringify({ workspaceId: "not-a-uuid", sessionKey: "ws:x/t1/p1", kind: "idle" }),
    });
    expect(res.status).toBe(400);
  });

  it("points an item at the terminal session that raised it", async () => {
    await seedWorkspace(workspaceId, "Fix the API");
    const sessionKey = `ws:${workspaceId}/t2/p1`;
    await app.request("/ingest/attention", {
      method: "POST",
      headers: ingestAuth,
      body: JSON.stringify({ workspaceId, sessionKey, kind: "permission" }),
    });

    const list = await app.request("/api/attention?status=pending", { headers: bearer });
    const rows = (await list.json()) as { sessionKey: string; navTarget: unknown }[];
    expect(rows[0]!.sessionKey).toBe(sessionKey);
    expect(rows[0]!.navTarget).toEqual({ type: "terminal", sessionKey, workspaceId });
  });

  it("accepts a session outside any workspace", async () => {
    const res = await app.request("/ingest/attention", {
      method: "POST",
      headers: ingestAuth,
      body: JSON.stringify({ sessionKey: "tab:terminal/t1/p1", kind: "idle" }),
    });
    expect(res.status).toBe(201);

    const list = await app.request("/api/attention?status=pending", { headers: bearer });
    const rows = (await list.json()) as { workspaceId: string | null; navTarget: unknown }[];
    expect(rows[0]!.workspaceId).toBeNull();
    expect(rows[0]!.navTarget).toEqual({ type: "terminal", sessionKey: "tab:terminal/t1/p1" });
  });

  it("clears a whole workspace's pending items in one request", async () => {
    await seedWorkspace(workspaceId, "WS");
    for (const sessionKey of [`ws-claude:${workspaceId}`, `ws:${workspaceId}/t2/p1`]) {
      await app.request("/ingest/attention", {
        method: "POST",
        headers: ingestAuth,
        body: JSON.stringify({ workspaceId, sessionKey, kind: "idle" }),
      });
    }

    const cleared = await app.request("/api/attention/clear", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ workspaceId, status: "read" }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as unknown[]).toHaveLength(2);

    const after = await app.request("/api/attention?status=pending", { headers: bearer });
    expect((await after.json()) as unknown[]).toHaveLength(0);
  });

  it("rejects a clear that names no scope, or both at once", async () => {
    const none = await app.request("/api/attention/clear", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ status: "read" }),
    });
    expect(none.status).toBe(400);

    // Both would clear the union, not the intersection the body appears to name.
    const both = await app.request("/api/attention/clear", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ workspaceId, sessionKey: "ws-claude:x", status: "read" }),
    });
    expect(both.status).toBe(400);
  });

  it("patches an item's status", async () => {
    await seedWorkspace(workspaceId, "WS");
    await app.request("/ingest/attention", {
      method: "POST",
      headers: ingestAuth,
      body: JSON.stringify({ workspaceId, sessionKey: `ws-claude:${workspaceId}`, kind: "idle" }),
    });
    const list = await app.request("/api/attention?status=pending", { headers: bearer });
    const [row] = (await list.json()) as { id: string }[];

    const patched = await app.request(`/api/attention/${row!.id}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ status: "read" }),
    });
    expect(patched.status).toBe(200);

    const after = await app.request("/api/attention?status=pending", { headers: bearer });
    expect((await after.json()) as unknown[]).toHaveLength(0);
  });
});
