import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { addMessage, createSession, getMessages, listSessions } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
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

  it("bumps updatedAt at the same precision the column is created with", async () => {
    // The ordering test above raced this and only caught it about one run in
    // twelve. The defect is precision, not timing: the bump came from a JS
    // `Date`, which truncates to milliseconds, while creation uses the
    // database's `now()`, which keeps microseconds — so a bump could land
    // *behind* a session created moments earlier and sort below it.
    //
    // Asserting on the sub-millisecond digits tests that directly. A truncated
    // timestamp has none, ever; a real `now()` has them for all but roughly one
    // microsecond in a thousand, so a few rounds make a false failure
    // impossible in practice while a regression fails on the first run.
    const session = await createSession(db, "Precision");
    const subMilliseconds: number[] = [];
    for (let round = 0; round < 5; round++) {
      await addMessage(db, { sessionId: session.id, role: "user", content: "ping" });
      const [row] = await sql<{ sub: number }[]>`
        SELECT (extract(microseconds from updated_at)::int % 1000) AS sub
        FROM chat_sessions WHERE id = ${session.id}
      `;
      subMilliseconds.push(row!.sub);
    }
    expect(subMilliseconds.some((sub) => sub !== 0)).toBe(true);
  });
});
