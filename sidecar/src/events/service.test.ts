import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSession } from "../chat/service.ts";
import * as schema from "../db/schema.ts";
import { completeTask, createTask } from "../tasks/service.ts";
import {
  countEvents,
  countEventsByType,
  emitEvent,
  listEvents,
  markEventsProcessed,
  pageEvents,
  recordEvent,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE events RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE tasks RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("events service", () => {
  it("records and lists an event", async () => {
    const rec = await recordEvent(db, {
      type: "pr.viewed",
      source: "github",
      payload: { owner: "a", repo: "b", number: 1 },
    });
    expect(rec.type).toBe("pr.viewed");
    expect(rec.processedAt).toBeNull();

    const all = await listEvents(db);
    expect(all.map((e) => e.id)).toContain(rec.id);
  });

  it("filters by type and unprocessed state", async () => {
    await recordEvent(db, { type: "pr.viewed" });
    const processed = await recordEvent(db, { type: "alarm.created" });
    await sql`UPDATE events SET processed_at = now() WHERE id = ${processed.id}`;

    const prs = await listEvents(db, { type: "pr.viewed" });
    expect(prs.length).toBe(1);
    expect(prs[0]!.type).toBe("pr.viewed");

    const unprocessed = await listEvents(db, { unprocessedOnly: true });
    expect(unprocessed.map((e) => e.id)).not.toContain(processed.id);
    expect(unprocessed.length).toBe(1);
  });

  it("emitEvent swallows failures without poisoning later writes", async () => {
    // A db whose insert throws stands in for any persistence failure.
    const brokenDb = {
      insert: () => {
        throw new Error("boom");
      },
    } as unknown as typeof db;

    // Must not throw, even though the underlying insert fails.
    await emitEvent(brokenDb, { type: "pr.viewed" });

    // A subsequent real write still succeeds — the failure didn't leave state behind.
    const rec = await recordEvent(db, { type: "pr.viewed" });
    expect(rec.id).toBeDefined();
    expect((await listEvents(db)).length).toBe(1);
  });

  it("orders newest-first by occurredAt", async () => {
    const older = await recordEvent(db, {
      type: "pr.viewed",
      occurredAt: new Date("2020-01-01T00:00:00Z"),
    });
    const newer = await recordEvent(db, {
      type: "pr.viewed",
      occurredAt: new Date("2024-01-01T00:00:00Z"),
    });
    const all = await listEvents(db, { type: "pr.viewed" });
    expect(all[0]!.id).toBe(newer.id);
    expect(all[1]!.id).toBe(older.id);
  });
});

describe("event querying", () => {
  it("pages with a total that matches the filter", async () => {
    for (let i = 0; i < 5; i++) await recordEvent(db, { type: "pr.viewed" });
    await recordEvent(db, { type: "alarm.created" });

    const page = await pageEvents(db, { type: "pr.viewed", limit: 2, offset: 2 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(5);
    expect(await countEvents(db)).toBe(6);
  });

  it("matches a search against type, source, and payload", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      source: "github",
      payload: { title: "Add pgvector index" },
    });
    await recordEvent(db, { type: "alarm.created", source: "alarms" });

    expect((await listEvents(db, { search: "pgvector" })).length).toBe(1);
    expect((await listEvents(db, { search: "alarms" })).length).toBe(1);
    expect((await listEvents(db, { search: "pr." })).length).toBe(1);
    // A wildcard in the query is matched literally rather than expanding.
    expect((await listEvents(db, { search: "%" })).length).toBe(0);
  });

  it("filters by several types at once and can read oldest-first", async () => {
    const first = await recordEvent(db, {
      type: "pr.approved",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    const second = await recordEvent(db, {
      type: "pr.merged",
      occurredAt: new Date("2026-01-02T00:00:00Z"),
    });
    await recordEvent(db, { type: "alarm.created" });

    const rows = await listEvents(db, {
      types: ["pr.approved", "pr.merged"],
      oldestFirst: true,
    });
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it("marks a batch processed so the next unprocessed read skips it", async () => {
    const a = await recordEvent(db, { type: "pr.viewed" });
    const b = await recordEvent(db, { type: "pr.merged" });
    expect(await markEventsProcessed(db, [a.id])).toBe(1);
    expect(await markEventsProcessed(db, [])).toBe(0);

    const unprocessed = await listEvents(db, { unprocessedOnly: true });
    expect(unprocessed.map((r) => r.id)).toEqual([b.id]);
  });

  it("counts by type over a window", async () => {
    await recordEvent(db, {
      type: "pr.approved",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    await recordEvent(db, { type: "pr.approved" });
    await recordEvent(db, { type: "pr.merged" });

    const counts = await countEventsByType(db, { since: new Date("2026-01-02T00:00:00Z") });
    expect(counts).toEqual([
      { type: "pr.approved", count: 1 },
      { type: "pr.merged", count: 1 },
    ]);
  });
});

describe("event emission hooks", () => {
  it("records chat.started when a session is created", async () => {
    const session = await createSession(db, "hello");
    const started = await listEvents(db, { type: "chat.started" });
    expect(started.length).toBe(1);
    expect((started[0]!.payload as { sessionId: string }).sessionId).toBe(session.id);
  });

  it("records task.created and task.completed", async () => {
    const task = await createTask(db, { title: "ship it", scope: "daily" });
    await completeTask(db, task.id);

    const created = await listEvents(db, { type: "task.created" });
    const completed = await listEvents(db, { type: "task.completed" });
    expect(created.length).toBe(1);
    expect(completed.length).toBe(1);
    expect((completed[0]!.payload as { taskId: string }).taskId).toBe(task.id);
  });
});
