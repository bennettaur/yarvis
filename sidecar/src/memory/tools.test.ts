import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { HashEmbedder } from "./embedder.ts";
import { PgVectorMemoryStore } from "./index.ts";
import { buildMemoryTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const store = new PgVectorMemoryStore(db, new HashEmbedder());
const tools = buildMemoryTools(store, "session-1");

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

beforeEach(async () => {
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("chat memory tools", () => {
  it("remember with validFor stores an expiry measured from now", async () => {
    const before = Date.now();
    const result = (await tools.remember.execute!(
      { content: "GitHub is down", kind: "fact", validFor: "PT1H" },
      opts,
    )) as { id: string; validity: string; validUntil: string };

    expect(result.validity).toBe("current");
    const validUntil = new Date(result.validUntil).getTime();
    expect(validUntil - before).toBeGreaterThanOrEqual(HOUR);
    expect(validUntil - Date.now()).toBeLessThanOrEqual(HOUR);
    expect((await store.get(result.id))?.validUntil?.getTime()).toBe(validUntil);
  });

  it("remember refuses validFor with validUntil and stores nothing", async () => {
    const result = await tools.remember.execute!(
      { content: "x", kind: "fact", validFor: "PT1H", validUntil: "2030-01-01T00:00:00Z" },
      opts,
    );

    expect(result).toEqual({ error: "give validFor or validUntil, not both" });
    expect(await store.count()).toBe(0);
  });

  it("recall reports an expired memory as expired, with its window", async () => {
    await store.add("GitHub is down", {
      validFrom: new Date(Date.now() - 2 * HOUR),
      validUntil: new Date(Date.now() - HOUR),
    });

    const result = (await tools.recall.execute!({ query: "GitHub is down" }, opts)) as {
      results: { validity: string; validUntil?: string }[];
    };
    expect(result.results[0]?.validity).toBe("expired");
    expect(result.results[0]?.validUntil).toBeDefined();
  });

  it("recall asOf a past time finds a memory corrected since", async () => {
    const backThen = new Date(Date.now() - 10 * DAY);
    const original = await store.add("the events project is in design", {
      kind: "project",
      validFrom: backThen,
    });
    await tools.correct_memory.execute!(
      { id: original.id, content: "the events project is shipped" },
      opts,
    );

    const result = (await tools.recall.execute!(
      { query: "events project", asOf: new Date(backThen.getTime() + DAY).toISOString() },
      opts,
    )) as { results: { id: string; validity: string }[] };
    expect(result.results.map((r) => r.id)).toEqual([original.id]);
    expect(result.results[0]?.validity).toBe("current");
  });

  it("confirm_memory on a memory that hasn't started measures from its start", async () => {
    const startsAt = new Date(Date.now() + 7 * DAY);
    const upcoming = await store.add("the user is on vacation", {
      validFrom: startsAt,
      validUntil: new Date(startsAt.getTime() + 7 * DAY),
    });

    const result = (await tools.confirm_memory.execute!(
      { id: upcoming.id, validFor: "P1D" },
      opts,
    )) as { confirmCount: number; validUntil: string };
    expect(result.confirmCount).toBe(1);
    expect(new Date(result.validUntil)).toEqual(new Date(startsAt.getTime() + DAY));
  });

  it("confirm_memory refuses a corrected or unknown memory", async () => {
    const rec = await store.add("GitHub is down");
    await store.supersede(rec.id, "GitHub is back up");

    expect(await tools.confirm_memory.execute!({ id: rec.id }, opts)).toEqual({
      error: "no current memory with that id",
    });
    expect(
      await tools.confirm_memory.execute!({ id: "00000000-0000-4000-8000-000000000000" }, opts),
    ).toEqual({ error: "no current memory with that id" });
  });
});
