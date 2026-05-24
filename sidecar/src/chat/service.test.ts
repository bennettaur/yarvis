import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { addMessage, createSession, getMessages, listSessions } from "./service.ts";

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

describe("chat service", () => {
  it("creates a session and stores ordered messages", async () => {
    const session = await createSession(db, "Planning");
    expect(session.id).toBeString();

    await addMessage(db, { sessionId: session.id, role: "user", content: "hello" });
    await addMessage(db, {
      sessionId: session.id,
      role: "assistant",
      content: "hi there",
    });

    const messages = await getMessages(db, session.id);
    expect(messages.map((m) => m.content)).toEqual(["hello", "hi there"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("orders sessions by most recently updated", async () => {
    const first = await createSession(db, "First");
    const second = await createSession(db, "Second");

    // A new message in the first session bumps it to the top.
    await addMessage(db, { sessionId: first.id, role: "user", content: "ping" });

    const sessions = await listSessions(db);
    expect(sessions[0]!.id).toBe(first.id);
    expect(sessions[1]!.id).toBe(second.id);
  });
});
