import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { listTasks } from "../tasks/service.ts";
import { createSession } from "./service.ts";
import { buildTaskTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

describe("task tools", () => {
  it("create_task persists the task with the chat session as its source", async () => {
    const session = await createSession(db, "chat");
    const tools = buildTaskTools(db, session.id);

    await tools.create_task.execute!(
      { title: "ship it", scope: "daily", targetDate: "2026-05-24" },
      opts,
    );

    const open = await listTasks(db, { status: "open" });
    expect(open.length).toBe(1);
    expect(open[0]!.sourceSessionId).toBe(session.id);
  });

  it("list_tasks returns previously created tasks", async () => {
    const session = await createSession(db);
    const tools = buildTaskTools(db, session.id);
    await tools.create_task.execute!({ title: "a", scope: "weekly" }, opts);

    const result = (await tools.list_tasks.execute!({ status: "open" }, opts)) as unknown[];
    expect(result.length).toBe(1);
  });

  it("delete_task removes a task by id", async () => {
    const session = await createSession(db);
    const tools = buildTaskTools(db, session.id);
    await tools.create_task.execute!({ title: "scrap this", scope: "daily" }, opts);
    const [task] = await listTasks(db, { status: "open" });

    const result = (await tools.delete_task.execute!({ id: task!.id }, opts)) as {
      deleted?: boolean;
    };
    expect(result.deleted).toBe(true);
    expect((await listTasks(db)).length).toBe(0);
  });

  it("delete_task reports not found for an unknown id", async () => {
    const session = await createSession(db);
    const tools = buildTaskTools(db, session.id);

    const result = (await tools.delete_task.execute!(
      { id: "00000000-0000-0000-0000-000000000000" },
      opts,
    )) as { error?: string };
    expect(result.error).toBe("not found");
  });
});
