import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: url,
  secrets: {},
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE memories, tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("memory routes", () => {
  it("requires authentication", async () => {
    expect((await app.request("/api/memory")).status).toBe(401);
  });

  it("adds a note and lists it filtered by type", async () => {
    const add = await app.request("/api/memory/notes", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ content: "remember to water the plants" }),
    });
    expect(add.status).toBe(201);

    const notes = (await (
      await app.request("/api/memory?type=note", { headers: auth })
    ).json()) as unknown[];
    expect(notes.length).toBe(1);
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

    const docs = (await (
      await app.request("/api/memory?type=doc", { headers: auth })
    ).json()) as unknown[];
    expect(docs.length).toBe(result.chunks);
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
