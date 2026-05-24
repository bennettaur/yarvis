import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  completeTask,
  createTask,
  listTasks,
  rolloverTasks,
  tasksCompletedBetween,
  updateTask,
} from "./service.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("task service", () => {
  it("creates a task with sensible defaults", async () => {
    const task = await createTask(db, {
      title: "Write the plan",
      scope: "daily",
      targetDate: "2026-05-24",
    });
    expect(task.id).toBeString();
    expect(task.status).toBe("open");
    expect(task.scope).toBe("daily");
    expect(task.targetDate).toBe("2026-05-24");
    expect(task.completedAt).toBeNull();
  });

  it("lists tasks filtered by status, scope, and target date", async () => {
    await createTask(db, { title: "A", scope: "daily", targetDate: "2026-05-24" });
    await createTask(db, { title: "B", scope: "weekly", targetDate: "2026-05-29" });
    const done = await createTask(db, { title: "C", scope: "daily" });
    await completeTask(db, done.id);

    expect((await listTasks(db, { status: "open" })).length).toBe(2);
    expect((await listTasks(db, { scope: "weekly" })).length).toBe(1);
    expect((await listTasks(db, { targetDate: "2026-05-24" })).length).toBe(1);
    expect((await listTasks(db, { status: "done" })).length).toBe(1);
  });

  it("completes a task and stamps completedAt", async () => {
    const task = await createTask(db, { title: "Ship it", scope: "daily" });
    const completed = await completeTask(db, task.id);
    expect(completed?.status).toBe("done");
    expect(completed?.completedAt).not.toBeNull();
  });

  it("returns null when completing a missing task", async () => {
    const missing = await completeTask(
      db,
      "00000000-0000-0000-0000-000000000000",
    );
    expect(missing).toBeNull();
  });

  it("reopening a task clears completedAt", async () => {
    const task = await createTask(db, { title: "Redo", scope: "daily" });
    await completeTask(db, task.id);
    const reopened = await updateTask(db, task.id, { status: "open" });
    expect(reopened?.status).toBe("open");
    expect(reopened?.completedAt).toBeNull();
  });

  it("returns only tasks completed within the given window", async () => {
    const inWindow = await createTask(db, { title: "in window", scope: "daily" });
    await completeTask(db, inWindow.id); // completedAt = now
    const open = await createTask(db, { title: "still open", scope: "daily" });
    void open; // never completed, must be excluded

    const now = new Date();
    const from = new Date(now.getTime() - 60_000);
    const to = new Date(now.getTime() + 60_000);
    const within = await tasksCompletedBetween(db, from, to);
    expect(within.length).toBe(1);
    expect(within[0]!.title).toBe("in window");

    // A window entirely in the past excludes the just-completed task.
    const past = await tasksCompletedBetween(
      db,
      new Date(now.getTime() - 120_000),
      new Date(now.getTime() - 60_000),
    );
    expect(past.length).toBe(0);
  });

  it("rolls open tasks from one date to another, leaving done ones", async () => {
    await createTask(db, { title: "carryover", scope: "daily", targetDate: "2026-05-23" });
    const finished = await createTask(db, {
      title: "finished",
      scope: "daily",
      targetDate: "2026-05-23",
    });
    await completeTask(db, finished.id);

    const moved = await rolloverTasks(db, "2026-05-23", "2026-05-24");
    expect(moved.length).toBe(1);
    expect(moved[0]!.title).toBe("carryover");
    expect(moved[0]!.targetDate).toBe("2026-05-24");

    // The completed task stays on its original date.
    expect((await listTasks(db, { targetDate: "2026-05-23" })).length).toBe(1);
  });
});
