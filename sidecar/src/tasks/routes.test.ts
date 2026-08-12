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
  mcpToken: "test-mcp-token",
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
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("task routes", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/tasks");
    expect(res.status).toBe(401);
  });

  it("creates and lists tasks", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "X", scope: "daily", targetDate: "2026-05-24" }),
    });
    expect(create.status).toBe(201);

    const list = await app.request("/api/tasks?status=open", { headers: auth });
    const tasks = (await list.json()) as unknown[];
    expect(tasks.length).toBe(1);
  });

  it("rejects an invalid create body", async () => {
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ scope: "daily" }), // missing title
    });
    expect(res.status).toBe(400);
  });

  it("completes a task", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "done me", scope: "daily" }),
    });
    const task = (await create.json()) as { id: string };

    const complete = await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth,
    });
    expect(complete.status).toBe(200);
    expect(((await complete.json()) as { status: string }).status).toBe("done");
  });

  it("deletes a task", async () => {
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "delete me", scope: "daily" }),
    });
    const task = (await create.json()) as { id: string };

    const del = await app.request(`/api/tasks/${task.id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(200);

    const list = await app.request("/api/tasks", { headers: auth });
    expect(((await list.json()) as unknown[]).length).toBe(0);
  });

  it("returns 404 when deleting a missing task", async () => {
    const res = await app.request("/api/tasks/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("rolls tasks over to a new date", async () => {
    await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "carry", scope: "daily", targetDate: "2026-05-23" }),
    });
    const res = await app.request("/api/tasks/rollover", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ fromDate: "2026-05-23", toDate: "2026-05-24" }),
    });
    expect(((await res.json()) as { moved: number }).moved).toBe(1);
  });
});
