import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { chooseEmbedder, HashEmbedder } from "./embedder.ts";
import { PgVectorMemoryStore } from "./index.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const store = new PgVectorMemoryStore(db, new HashEmbedder());

const baseConfig: Config = {
  port: 0,
  token: "t",
  tokenGenerated: true,
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

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE embeddings_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  // The suite deliberately writes a bad-dimension provider row; leaving it
  // behind would break every other file whose routes select an embedder.
  await sql`TRUNCATE embeddings_config RESTART IDENTITY CASCADE`;
  await sql.end();
});

describe("pgvector memory store", () => {
  it("adds and retrieves a memory by id", async () => {
    const rec = await store.add("the user prefers dark mode", {
      kind: "preference",
      metadata: { tag: "pref" },
    });
    const got = await store.get(rec.id);
    expect(got?.content).toBe("the user prefers dark mode");
  });

  it("ranks semantically closer memories higher", async () => {
    await store.add("I love hiking in the mountains");
    await store.add("My favorite database is PostgreSQL");

    const results = await store.search("favorite database", 2);
    expect(results.length).toBe(2);
    expect(results[0]!.content).toContain("database");
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score ?? 0);
  });

  it("deletes a memory", async () => {
    const rec = await store.add("a temporary note");
    expect(await store.delete(rec.id)).toBe(true);
    expect(await store.get(rec.id)).toBeNull();
  });

  it("adds many memories in one batch", async () => {
    const records = await store.addMany([
      { content: "chunk one", kind: "doc" },
      { content: "chunk two", kind: "doc" },
    ]);
    expect(records.length).toBe(2);
    expect((await store.list({ kinds: ["doc"] })).length).toBe(2);
  });

  it("lists memories and filters by kind", async () => {
    await store.add("a fact");
    await store.add("note one", { kind: "note" });
    await store.add("note two", { kind: "note" });

    expect((await store.list()).length).toBe(3);
    expect(await store.count()).toBe(3);
    const notes = await store.list({ kinds: ["note"] });
    expect(notes.length).toBe(2);
    expect(notes.every((n) => n.kind === "note")).toBe(true);
    expect(await store.count({ kinds: ["note"] })).toBe(2);
  });

  it("pages a list with an offset", async () => {
    await store.addMany([{ content: "first" }, { content: "second" }, { content: "third" }]);
    const page = await store.list({ limit: 2, offset: 2 });
    expect(page.length).toBe(1);
  });

  it("re-embeds an edited memory so it is found by what it now says", async () => {
    const rec = await store.add("the user is working on the calendar integration");
    await store.update(rec.id, { content: "the user is working on the telegram bot" });

    const hits = await store.search("telegram bot", 1);
    expect(hits[0]?.id).toBe(rec.id);
    expect(hits[0]?.content).toContain("telegram");
  });

  it("keeps a superseded memory but leaves it out of recall", async () => {
    const original = await store.add("the events project is in design", { kind: "project" });
    const replacement = await store.supersede(original.id, "the events project is shipped");

    expect(replacement?.kind).toBe("project");
    // Both rows still exist, but only the replacement is reachable by default.
    expect((await store.list()).map((m) => m.id)).toEqual([replacement!.id]);
    expect((await store.list({ includeSuperseded: true })).length).toBe(2);
    expect((await store.get(original.id))?.supersededAt).not.toBeNull();

    const hits = await store.search("events project", 10);
    expect(hits.map((h) => h.id)).not.toContain(original.id);
    const withOld = await store.search("events project", 10, { includeSuperseded: true });
    expect(withOld.map((h) => h.id)).toContain(original.id);
  });

  it("narrows a search to the kinds asked for", async () => {
    await store.add("the calendar work is blocked on OAuth scopes", { kind: "project" });
    await store.add("calendar OAuth scopes need re-consent", { kind: "note" });

    const hits = await store.search("calendar oauth", 5, { kinds: ["note"] });
    expect(hits.length).toBe(1);
    expect(hits[0]!.kind).toBe("note");
  });

  it("stamps the producing embedder onto each memory", async () => {
    const rec = await store.add("stamped");
    const got = await store.get(rec.id);
    expect((got!.metadata as any).embedder).toEqual({
      kind: "hash",
      model: "hash",
      dim: schema.EMBED_DIM,
    });
  });

  it("reports healthy when all memories match the active embedder", async () => {
    await store.add("one");
    await store.add("two");
    const health = await store.embedderHealth();
    expect(health.ok).toBe(true);
    expect(health.mismatchedCount).toBe(0);
    expect(health.active.kind).toBe("hash");
  });

  it("flags a mismatch and clears it after re-embedding", async () => {
    const rec = await store.add("legacy memory");
    // Simulate a vector produced by a different embedder.
    await sql`
      UPDATE memories
      SET metadata = jsonb_set(metadata, '{embedder}',
        '{"kind":"gemini","model":"text-embedding-004","dim":768}'::jsonb)
      WHERE id = ${rec.id}`;

    const before = await store.embedderHealth();
    expect(before.ok).toBe(false);
    expect(before.mismatchedCount).toBe(1);

    const count = await store.reembedAll();
    expect(count).toBe(1);

    const after = await store.embedderHealth();
    expect(after.ok).toBe(true);
  });

  it("rejects a configured embedder whose dimension doesn't match the column", async () => {
    // A row with the wrong dimension shouldn't normally exist (the PUT route
    // rejects it), but chooseEmbedder guards against it regardless.
    await sql`
      INSERT INTO embeddings_config (base_url, model, api_kind, dimensions)
      VALUES ('http://localhost:11434/v1', 'wrong-dims', 'openai', ${schema.EMBED_DIM + 1})`;
    await expect(chooseEmbedder(baseConfig, db)).rejects.toThrow(/dimension/i);
  });
});
