import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { EMBED_DIM } from "../db/schema.ts";

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

// The embeddings provider config now lives in ~/.yarvis/settings.json, not
// Postgres — isolate every test from the developer's real one.
let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  await sql`TRUNCATE memories, tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-memory-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("memory routes", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/memory")).status).toBe(401);
  });

  it("adds a note and lists it filtered by kind", async () => {
    const add = await app.request("/api/memory/notes", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ content: "remember to water the plants" }),
    });
    expect(add.status).toBe(201);

    const notes = (await (
      await app.request("/api/memory?kind=note", { headers: auth })
    ).json()) as { items: unknown[]; total: number };
    expect(notes.total).toBe(1);
  });

  it("ingests pasted text into retrievable doc chunks", async () => {
    const res = await app.request("/api/memory/ingest", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ text: "alpha beta gamma delta.", title: "notes" }),
    });
    expect(res.status).toBe(201);
    const result = (await res.json()) as { chunks: number; source: string };
    expect(result.chunks).toBeGreaterThanOrEqual(1);

    const docs = (await (await app.request("/api/memory?kind=doc", { headers: auth })).json()) as {
      items: unknown[];
      total: number;
    };
    expect(docs.total).toBe(result.chunks);
  });

  it("rejects ingest with neither url nor text", async () => {
    const res = await app.request("/api/memory/ingest", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "nothing" }),
    });
    expect(res.status).toBe(400);
  });

  it("builds an offline recap from completed tasks and notes", async () => {
    // Seed a completed task (completedAt = now, inside today's window).
    const create = await app.request("/api/tasks", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "Ship the recap route", scope: "daily" }),
    });
    const task = (await create.json()) as { id: string };
    await app.request(`/api/tasks/${task.id}/complete`, {
      method: "POST",
      headers: auth,
    });
    await app.request("/api/memory/notes", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ content: "Reviewer asked for recap tests" }),
    });

    // No provider/model -> offline path returns the assembled material verbatim.
    const res = await app.request("/api/memory/recap", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ range: "day" }),
    });
    expect(res.status).toBe(200);
    const recap = (await res.json()) as {
      label: string;
      recap: string;
      tasks: unknown[];
      notes: unknown[];
    };
    expect(recap.label).toBe("today");
    expect(recap.tasks.length).toBe(1);
    expect(recap.notes.length).toBe(1);
    expect(recap.recap).toContain("Ship the recap route");
    expect(recap.recap).toContain("Reviewer asked for recap tests");
  });
});

describe("embeddings config routes", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/memory/embeddings/config")).status).toBe(401);
  });

  it("saves and reads back the config", async () => {
    const put = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        apiKind: "openai",
        dimensions: EMBED_DIM,
        headerNames: [],
      }),
    });
    expect(put.status).toBe(200);

    const get = await app.request("/api/memory/embeddings/config", { headers: auth });
    const { config: saved } = (await get.json()) as { config: { model: string } | null };
    expect(saved?.model).toBe("nomic-embed-text");
  });

  it("rejects a dimension that doesn't match the memories column", async () => {
    const res = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        model: "wrong-dims",
        apiKind: "openai",
        dimensions: EMBED_DIM + 1,
        headerNames: [],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed input", async () => {
    const res = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ baseUrl: "not a url" }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes the configured provider", async () => {
    await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({
        baseUrl: "http://localhost:11434/v1",
        model: "nomic-embed-text",
        apiKind: "openai",
        dimensions: EMBED_DIM,
        headerNames: [],
      }),
    });
    const del = await app.request("/api/memory/embeddings/config", {
      method: "DELETE",
      headers: auth,
    });
    expect(await del.json()).toEqual({ deleted: true });

    const get = await app.request("/api/memory/embeddings/config", { headers: auth });
    expect(((await get.json()) as { config: unknown }).config).toBeNull();
  });
});

describe("POST /api/memory/reembed", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/memory/reembed", { method: "POST" })).status).toBe(401);
  });

  it("re-embeds stored memories and reports the count", async () => {
    await app.request("/api/memory/notes", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ content: "remember to water the plants" }),
    });
    const res = await app.request("/api/memory/reembed", { method: "POST", headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reembedded: 1 });
  });
});
