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
  await sql`TRUNCATE projects, agent_todos, tasks, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

async function createProject(name: string): Promise<{ id: string }> {
  const res = await app.request("/api/projects", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ name }),
  });
  return (await res.json()) as { id: string };
}

describe("project routes", () => {
  it("creates, reads back with items, and lists", async () => {
    const project = await createProject("Events");
    const item = await app.request(`/api/projects/${project.id}/items`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        kind: "jira",
        externalKey: "PROJ-1",
        title: "the job",
        priority: "high",
      }),
    });
    expect(item.status).toBe(201);

    const overview = (await (
      await app.request(`/api/projects/${project.id}`, { headers: auth })
    ).json()) as { project: { name: string }; items: { externalKey: string }[] };
    expect(overview.project.name).toBe("Events");
    expect(overview.items[0]!.externalKey).toBe("PROJ-1");

    const list = (await (
      await app.request("/api/projects", { headers: auth })
    ).json()) as unknown[];
    expect(list.length).toBe(1);
  });

  it("answers 200 rather than a conflict when the name already exists", async () => {
    await createProject("Events");
    const again = await app.request("/api/projects", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "events" }),
    });
    expect(again.status).toBe(200);
  });

  it("rejects an unknown status filter", async () => {
    const res = await app.request("/api/projects?status=nonsense", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("404s an unknown project", async () => {
    const res = await app.request("/api/projects/00000000-0000-4000-8000-000000000000", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    expect((await app.request("/api/projects")).status).toBe(401);
  });
});

describe("todo routes", () => {
  it("creates a todo, appends a note through a patch, and lists it", async () => {
    const created = await app.request("/api/todos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "prep the demo", priority: "high" }),
    });
    expect(created.status).toBe(201);
    const todo = (await created.json()) as { id: string };

    await app.request(`/api/todos/${todo.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ status: "in_progress", note: "slides started" }),
    });

    const rows = (await (await app.request("/api/todos", { headers: auth })).json()) as {
      status: string;
      notes: { text: string }[];
    }[];
    expect(rows[0]!.status).toBe("in_progress");
    expect(rows[0]!.notes[0]!.text).toBe("slides started");
  });

  it("filters by status and rejects an unknown one", async () => {
    await app.request("/api/todos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "open one" }),
    });
    const done = (await (
      await app.request("/api/todos?status=done", { headers: auth })
    ).json()) as unknown[];
    expect(done).toEqual([]);

    const bad = await app.request("/api/todos?status=maybe", { headers: auth });
    expect(bad.status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await app.request("/api/todos")).status).toBe(401);
  });
});

describe("job routes", () => {
  it("reports each registered job with whether it is due", async () => {
    const body = (await (await app.request("/api/jobs", { headers: auth })).json()) as {
      jobs: { name: string; due: boolean }[];
    };
    expect(body.jobs.map((j) => j.name)).toContain("consolidate-events");
    // Nothing has run yet, so everything is due.
    expect(body.jobs.every((j) => j.due)).toBe(true);
  });

  it("404s an unknown job rather than running something", async () => {
    const res = await app.request("/api/jobs/not-a-job/run", { method: "POST", headers: auth });
    expect(res.status).toBe(404);
  });
});
