import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { HashEmbedder } from "./embedder.ts";
import { PgVectorMemoryStore } from "./index.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const store = new PgVectorMemoryStore(db, new HashEmbedder());

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
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
});
