import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { recordEvent } from "../events/service.ts";
import { completeTasks, completionCandidates } from "./reconcile.ts";
import { createTask, createTaskDeduped, findSimilarTasks, listTasks } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE tasks, events, workspaces RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("task deduplication", () => {
  it("reuses an open task that says the same thing", async () => {
    const first = await createTask(db, { title: "write the consolidation job", scope: "daily" });
    const second = await createTaskDeduped(db, {
      title: "Write the consolidation job",
      scope: "daily",
    });

    expect(second.duplicateOf?.id).toBe(first.id);
    expect(second.task.id).toBe(first.id);
    expect((await listTasks(db)).length).toBe(1);
  });

  it("creates a task when nothing close enough exists, and still reports near-misses", async () => {
    await createTask(db, { title: "review the events PR", scope: "daily" });
    const result = await createTaskDeduped(db, {
      title: "review the calendar PR and merge it",
      scope: "daily",
    });

    expect(result.duplicateOf).toBeUndefined();
    expect((await listTasks(db)).length).toBe(2);
    expect(result.similar.length).toBeGreaterThan(0);
  });

  it("does not treat a finished task as a duplicate of new work", async () => {
    const done = await createTask(db, { title: "ship the migration", scope: "daily" });
    await sql`UPDATE tasks SET status = 'done', completed_at = now() WHERE id = ${done.id}`;

    const again = await createTaskDeduped(db, { title: "ship the migration", scope: "daily" });
    expect(again.duplicateOf).toBeUndefined();
    expect(again.task.id).not.toBe(done.id);
    // But it is still findable when the caller asks to include finished work.
    expect((await findSimilarTasks(db, "ship the migration", { includeDone: true })).length).toBe(
      2,
    );
  });
});

describe("completion candidates", () => {
  it("flags a task whose linked workspace has been archived", async () => {
    const [workspace] = await sql`
      INSERT INTO workspaces (name, slug, root_path, status, archived_at)
      VALUES ('events consolidation', 'events-consolidation', '/tmp/ws', 'archived', now())
      RETURNING id`;
    const task = await createTask(db, { title: "build the events job", scope: "weekly" });
    await sql`UPDATE tasks SET workspace_id = ${workspace!.id} WHERE id = ${task.id}`;

    const candidates = await completionCandidates(db);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.task.id).toBe(task.id);
    expect(candidates[0]!.evidence[0]!.reason).toContain("archived");
  });

  it("flags a task whose words match a merged PR", async () => {
    const task = await createTask(db, { title: "add pgvector index for memories", scope: "daily" });
    await recordEvent(db, {
      type: "pr.merged",
      payload: { ref: "gh:me/app/12", title: "Add pgvector index for memories" },
    });

    const candidates = await completionCandidates(db);
    expect(candidates.map((c) => c.task.id)).toEqual([task.id]);
  });

  it("leaves unrelated open tasks alone", async () => {
    await createTask(db, { title: "book the dentist", scope: "daily" });
    await recordEvent(db, {
      type: "pr.merged",
      payload: { ref: "gh:me/app/12", title: "Add pgvector index" },
    });
    expect(await completionCandidates(db)).toEqual([]);
  });

  it("ignores signals older than the window", async () => {
    await createTask(db, { title: "add pgvector index", scope: "daily" });
    await recordEvent(db, {
      type: "pr.merged",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: { ref: "gh:me/app/12", title: "Add pgvector index" },
    });
    expect(await completionCandidates(db)).toEqual([]);
  });

  it("completes a confirmed batch and logs each one", async () => {
    const first = await createTask(db, { title: "one", scope: "daily" });
    const second = await createTask(db, { title: "two", scope: "daily" });
    await sql`TRUNCATE events`;

    const completed = await completeTasks(db, [first.id, second.id]);
    expect(completed.length).toBe(2);
    // A second call is a no-op: they are no longer open.
    expect((await completeTasks(db, [first.id])).length).toBe(0);

    const events = await sql`SELECT type FROM events`;
    expect(events.length).toBe(2);
    expect(events.every((e) => e.type === "task.completed")).toBe(true);
  });
});
