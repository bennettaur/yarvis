import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { createTodo, deleteTodo, getTodo, listTodos, updateTodo } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE agent_todos, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("agent todos", () => {
  it("creates a todo and lists it as open", async () => {
    const todo = await createTodo(db, { title: "prep the demo", priority: "high" });
    expect((await listTodos(db)).map((t) => t.id)).toEqual([todo.id]);
    expect(todo.status).toBe("pending");
  });

  it("orders by priority then by deadline", async () => {
    await createTodo(db, { title: "later", priority: "low" });
    await createTodo(db, {
      title: "soon",
      priority: "urgent",
      dueAt: new Date("2026-09-01T09:00:00Z"),
    });
    await createTodo(db, { title: "middling", priority: "medium" });

    expect((await listTodos(db)).map((t) => t.title)).toEqual(["soon", "middling", "later"]);
  });

  it("appends progress notes rather than replacing them", async () => {
    const todo = await createTodo(db, { title: "check the PR" });
    await updateTodo(db, todo.id, { note: "waiting on CI" });
    await updateTodo(db, todo.id, { status: "blocked", note: "CI is red on main too" });

    const after = await getTodo(db, todo.id);
    expect(after?.status).toBe("blocked");
    expect(after?.notes.map((n) => n.text)).toEqual(["waiting on CI", "CI is red on main too"]);
  });

  it("closes a todo, drops it from the open list, and reopens cleanly", async () => {
    const todo = await createTodo(db, { title: "book the room" });
    const done = await updateTodo(db, todo.id, { status: "done" });
    expect(done?.closedAt).not.toBeNull();
    expect(await listTodos(db)).toEqual([]);

    const reopened = await updateTodo(db, todo.id, { status: "in_progress" });
    expect(reopened?.closedAt).toBeNull();
    expect((await listTodos(db)).length).toBe(1);
  });

  it("records creation and closing as distinct events", async () => {
    const todo = await createTodo(db, { title: "draft the script" });
    await updateTodo(db, todo.id, { note: "half done" });
    await updateTodo(db, todo.id, { status: "wont_do" });

    const types = (await sql`SELECT type FROM events ORDER BY occurred_at`).map(
      (r) => r.type as string,
    );
    expect(types).toEqual(["todo.created", "todo.updated", "todo.closed"]);
  });

  it("keeps undated todos in a deadline-filtered list", async () => {
    await createTodo(db, { title: "undated" });
    await createTodo(db, { title: "next month", dueAt: new Date("2026-10-01T00:00:00Z") });

    const dueSoon = await listTodos(db, { dueBy: new Date("2026-09-01T00:00:00Z") });
    expect(dueSoon.map((t) => t.title)).toEqual(["undated"]);
  });

  it("reports a missing todo rather than throwing", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(await updateTodo(db, missing, { status: "done" })).toBeNull();
    expect(await deleteTodo(db, missing)).toBe(false);
  });
});
