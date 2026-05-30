import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSession } from "../chat/service.ts";
import * as schema from "../db/schema.ts";
import { createTask, completeTask } from "../tasks/service.ts";
import { listEvents, recordEvent } from "./service.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
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

describe("event emission hooks", () => {
  it("records chat.started when a session is created", async () => {
    const session = await createSession(db, "hello");
    const events = await listEvents(db, { type: "chat.started" });
    expect(events.length).toBe(1);
    expect((events[0]!.payload as { sessionId: string }).sessionId).toBe(
      session.id,
    );
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
