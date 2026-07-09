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
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces", claudeCommand: "claude",
  secrets: {},
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE embeddings_config RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("pgvector memory store", () => {
  it("adds and retrieves a memory by id", async () => {
    const rec = await store.add("the user prefers dark mode", { tag: "pref" });
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
      { content: "chunk one", metadata: { type: "doc" } },
      { content: "chunk two", metadata: { type: "doc" } },
    ]);
    expect(records.length).toBe(2);
    expect((await store.list({ type: "doc" })).length).toBe(2);
  });

  it("lists memories and filters by metadata type", async () => {
    await store.add("a fact", { type: "fact" });
    await store.add("note one", { type: "note" });
    await store.add("note two", { type: "note" });

    expect((await store.list()).length).toBe(3);
    const notes = await store.list({ type: "note" });
    expect(notes.length).toBe(2);
    expect(notes.every((n) => (n.metadata as any).type === "note")).toBe(true);
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
    expect(chooseEmbedder(baseConfig, db)).rejects.toThrow(/dimension/i);
  });
});
