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
