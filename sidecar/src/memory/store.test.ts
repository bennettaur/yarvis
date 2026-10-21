import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { chooseEmbedder, HashEmbedder } from "./embedder.ts";
import { upsertEmbeddingsConfig } from "./embeddingsConfig.ts";
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

// The embeddings provider config now lives in ~/.yarvis/settings.json, not
// Postgres — isolate each test from the real one.
let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-memory-store-"));
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
    // A config with the wrong dimension shouldn't normally exist (the PUT
    // route rejects it), but chooseEmbedder guards against it regardless.
    await upsertEmbeddingsConfig({
      baseUrl: "http://localhost:11434/v1",
      model: "wrong-dims",
      apiKind: "openai",
      dimensions: schema.EMBED_DIM + 1,
      headerNames: [],
    });
    await expect(chooseEmbedder(baseConfig, db)).rejects.toThrow(/dimension/i);
  });
});

describe("memory validity and decay", () => {
  const HOUR = 60 * 60_000;
  const DAY = 24 * HOUR;
  const start = new Date("2026-10-08T10:00:00Z");
  let clock = start;
  const timed = new PgVectorMemoryStore(db, new HashEmbedder(), () => clock);
  const later = (ms: number) => new Date(start.getTime() + ms);

  beforeEach(() => {
    clock = start;
  });

  it("still returns a memory past its validUntil, flagged expired", async () => {
    await timed.add("GitHub is down", { validUntil: later(HOUR) });
    expect((await timed.search("GitHub is down", 1))[0]?.validity).toBe("current");

    clock = later(DAY);
    const [hit] = await timed.search("GitHub is down", 1);
    expect(hit?.content).toBe("GitHub is down");
    expect(hit?.validity).toBe("expired");
  });

  it("ranks an expired memory below a current one that matches as well", async () => {
    const expiring = await timed.add("GitHub is down", { validUntil: later(HOUR) });
    const lasting = await timed.add("GitHub is down");
    clock = later(2 * HOUR);

    const hits = await timed.search("GitHub is down", 2);
    expect(hits.map((h) => h.id)).toEqual([lasting.id, expiring.id]);
    expect(hits[0]!.similarity).toBeCloseTo(hits[1]!.similarity!, 5);
  });

  it("ranks a long-unconfirmed memory below a fresh one that matches as well", async () => {
    const old = await timed.add("the deploy runs on Fridays");
    clock = later(365 * DAY);
    const fresh = await timed.add("the deploy runs on Fridays");

    const hits = await timed.search("the deploy runs on Fridays", 2);
    expect(hits.map((h) => h.id)).toEqual([fresh.id, old.id]);
    expect(hits[1]!.strength).toBeLessThan(hits[0]!.strength!);
  });

  it("confirming restarts decay and gives the original window again from now", async () => {
    const rec = await timed.add("GitHub is down", { validUntil: later(HOUR) });
    clock = later(DAY);

    const confirmed = await timed.confirm(rec.id);
    expect(confirmed?.confirmCount).toBe(1);
    expect(confirmed?.confirmedAt).toEqual(clock);
    expect(confirmed?.validUntil).toEqual(later(DAY + HOUR));
    expect(confirmed?.validity).toBe("current");

    const explicit = await timed.confirm(rec.id, { validUntil: later(DAY + 3 * HOUR) });
    expect(explicit?.confirmCount).toBe(2);
    expect(explicit?.validUntil).toEqual(later(DAY + 3 * HOUR));
  });

  it("won't confirm a memory that has been corrected", async () => {
    const rec = await timed.add("GitHub is down");
    await timed.supersede(rec.id, "GitHub is back up");
    expect(await timed.confirm(rec.id)).toBeNull();
  });

  it("closes a corrected memory's validity where its replacement starts", async () => {
    const original = await timed.add("the standup is at 9am");
    clock = later(DAY);
    await timed.supersede(original.id, "the standup is at 10am");
    expect((await timed.get(original.id))?.validUntil).toEqual(later(DAY));

    const backdated = await timed.add("the build uses webpack");
    clock = later(3 * DAY);
    await timed.supersede(backdated.id, "the build uses vite", { validFrom: later(2 * DAY) });
    expect((await timed.get(backdated.id))?.validUntil).toEqual(later(2 * DAY));
  });

  it("answers asOf from what held then, including memories corrected since", async () => {
    const design = await timed.add("the events project is in design", { kind: "project" });
    clock = later(10 * DAY);
    const shipped = await timed.supersede(design.id, "the events project is shipped");

    const then = await timed.search("events project", 5, { asOf: later(5 * DAY) });
    expect(then.map((h) => h.id)).toEqual([design.id]);
    expect(then[0]?.validity).toBe("current");

    const now = await timed.search("events project", 5, { asOf: clock });
    expect(now.map((h) => h.id)).toEqual([shipped!.id]);
  });

  it("keeps a future-dated memory upcoming until it starts", async () => {
    await timed.add("the user is on vacation", { validFrom: later(7 * DAY) });

    expect((await timed.search("vacation", 1))[0]?.validity).toBe("upcoming");
    expect(await timed.search("vacation", 1, { asOf: clock })).toEqual([]);
    expect((await timed.search("vacation", 1, { asOf: later(8 * DAY) })).length).toBe(1);
  });

  it("reads past the limit so a fresher match can outrank a stale, expired one", async () => {
    await timed.add("GitHub is down", { validUntil: later(HOUR) });
    clock = later(365 * DAY);
    const fresh = await timed.add("GitHub is down for everyone today");

    // The stale memory is the closest match, so only a search that reads past
    // `limit` sees the fresh one at all.
    const [hit] = await timed.search("GitHub is down", 1);
    expect(hit?.id).toBe(fresh.id);
  });

  it("confirming restores full strength and leaves an open-ended memory open-ended", async () => {
    const rec = await timed.add("the user prefers squash merges", { kind: "preference" });
    clock = later(400 * DAY);
    expect((await timed.search("squash merges", 1))[0]!.strength).toBeLessThan(1);

    const confirmed = await timed.confirm(rec.id);
    expect(confirmed?.validUntil).toBeNull();
    expect((await timed.search("squash merges", 1))[0]!.strength).toBe(1);
  });

  it("keeps the window length across repeated confirmations", async () => {
    const rec = await timed.add("GitHub is down", { validUntil: later(HOUR) });
    clock = later(DAY);
    await timed.confirm(rec.id);
    clock = later(3 * DAY);

    const again = await timed.confirm(rec.id);
    expect(again?.validUntil).toEqual(later(3 * DAY + HOUR));
  });

  it("leaves a window that had closed before it was recorded as it is", async () => {
    clock = later(3 * HOUR);
    const rec = await timed.add("GitHub was down this morning", {
      validFrom: start,
      validUntil: later(HOUR),
    });
    clock = later(DAY);

    expect((await timed.confirm(rec.id))?.validUntil).toEqual(later(HOUR));
  });

  it("won't correct a memory twice, so only one replacement stays live", async () => {
    const original = await timed.add("the standup is at 9am");
    const [first, second] = await Promise.all([
      timed.supersede(original.id, "the standup is at 10am"),
      timed.supersede(original.id, "the standup is at 11am"),
    ]);

    expect([first, second].filter(Boolean).length).toBe(1);
    expect((await timed.list()).length).toBe(1);
    expect(await timed.supersede(original.id, "the standup is at noon")).toBeNull();
  });

  it("records a corrected memory that never started as never having held", async () => {
    const upcoming = await timed.add("the user is on vacation", { validFrom: later(7 * DAY) });
    await timed.supersede(upcoming.id, "the vacation is cancelled");

    const closed = await timed.get(upcoming.id);
    expect(closed?.validUntil).toEqual(closed?.validFrom);
    for (const asOf of [start, later(7 * DAY), later(8 * DAY)]) {
      const hits = await timed.search("vacation", 5, { asOf });
      expect(hits.map((h) => h.id)).not.toContain(upcoming.id);
    }
  });

  it("refuses a validity window that ends before it starts", async () => {
    await expect(
      timed.add("backwards", { validFrom: later(HOUR), validUntil: start }),
    ).rejects.toThrow();
  });
});
