import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import {
  addMessage,
  createSession,
  getMessages,
  listSessions,
  PROMPT_TITLE_MAX,
  rewindToMessage,
  titleFromPrompt,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("titleFromPrompt", () => {
  it("takes the first non-blank line with its whitespace collapsed", () => {
    expect(titleFromPrompt("\n   \n  Plan   my\tweek \nwith details")).toBe("Plan my week");
  });

  it("keeps a line of exactly the cap", () => {
    const line = "x".repeat(PROMPT_TITLE_MAX);
    expect(titleFromPrompt(line)).toBe(line);
  });

  it("cuts a longer line to one short of the cap, plus an ellipsis", () => {
    const line = "x".repeat(PROMPT_TITLE_MAX + 1);
    expect(titleFromPrompt(line)).toBe(`${"x".repeat(PROMPT_TITLE_MAX - 1)}…`);
  });

  it("drops a space left at the cut", () => {
    const line = `${"x".repeat(PROMPT_TITLE_MAX - 2)} yz`;
    expect(titleFromPrompt(line)).toBe(`${"x".repeat(PROMPT_TITLE_MAX - 2)}…`);
  });

  it("counts an emoji as one character and never splits it", () => {
    const line = `${"x".repeat(PROMPT_TITLE_MAX - 2)}🙂🙂🙂`;
    expect(titleFromPrompt(line)).toBe(`${"x".repeat(PROMPT_TITLE_MAX - 2)}🙂…`);
  });

  it("gives no title for a blank prompt", () => {
    expect(titleFromPrompt("  \n\t ")).toBeNull();
  });
});

describe("chat service", () => {
  it("names an untitled chat after its first user message and keeps that name", async () => {
    const session = await createSession(db);
    await addMessage(db, { sessionId: session.id, role: "assistant", content: "Hi, I'm Yarvis" });
    await addMessage(db, { sessionId: session.id, role: "user", content: "Book a dentist visit" });
    await addMessage(db, { sessionId: session.id, role: "user", content: "Make it Tuesday" });

    const [listed] = await listSessions(db);
    expect(listed!.title).toBe("Book a dentist visit");
  });

  it("keeps a title the session was created with", async () => {
    const session = await createSession(db, "Planning");
    await addMessage(db, { sessionId: session.id, role: "user", content: "hello" });

    const [listed] = await listSessions(db);
    expect(listed!.title).toBe("Planning");
  });

  it("forgets a name whose prompt a rewind took back, so the next prompt names the chat", async () => {
    const session = await createSession(db);
    const first = await addMessage(db, { sessionId: session.id, role: "user", content: "Oops" });
    await addMessage(db, { sessionId: session.id, role: "assistant", content: "Hm?" });

    await rewindToMessage(db, session.id, first.id);
    await addMessage(db, { sessionId: session.id, role: "user", content: "Plan a trip" });

    const [listed] = await listSessions(db);
    expect(listed!.title).toBe("Plan a trip");
  });

  it("keeps the name when a rewind leaves the prompt that gave it", async () => {
    const session = await createSession(db);
    await addMessage(db, { sessionId: session.id, role: "user", content: "Plan a trip" });
    const second = await addMessage(db, { sessionId: session.id, role: "user", content: "Paris" });

    await rewindToMessage(db, session.id, second.id);

    const [listed] = await listSessions(db);
    expect(listed!.title).toBe("Plan a trip");
  });

  it("keeps a title the session was created with when a rewind clears the chat", async () => {
    const session = await createSession(db, "Planning");
    const first = await addMessage(db, { sessionId: session.id, role: "user", content: "hello" });

    await rewindToMessage(db, session.id, first.id);

    const [listed] = await listSessions(db);
    expect(listed!.title).toBe("Planning");
  });

  it("does not name a chat after a scheduled task's prompt", async () => {
    const session = await createSession(db);
    await addMessage(db, {
      sessionId: session.id,
      role: "user",
      content: "Check CI on #12",
      metadata: { scheduledTask: { id: "t1", attempt: 1, origin: "chat" } },
    });

    const [listed] = await listSessions(db);
    expect(listed!.title).toBeNull();
  });

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

  it("rewinds to a user message, dropping it and everything after", async () => {
    const session = await createSession(db, "Rewind");
    await addMessage(db, { sessionId: session.id, role: "user", content: "one" });
    await addMessage(db, { sessionId: session.id, role: "assistant", content: "reply one" });
    const second = await addMessage(db, { sessionId: session.id, role: "user", content: "two" });
    await addMessage(db, { sessionId: session.id, role: "assistant", content: "reply two" });

    expect(await rewindToMessage(db, session.id, second.id)).toBe(true);

    const messages = await getMessages(db, session.id);
    expect(messages.map((m) => m.content)).toEqual(["one", "reply one"]);
  });

  it("refuses to rewind to an assistant message or another session's message", async () => {
    const session = await createSession(db, "Mine");
    const other = await createSession(db, "Other");
    await addMessage(db, { sessionId: session.id, role: "user", content: "question" });
    const reply = await addMessage(db, { sessionId: session.id, role: "assistant", content: "a" });
    const foreign = await addMessage(db, { sessionId: other.id, role: "user", content: "theirs" });

    expect(await rewindToMessage(db, session.id, reply.id)).toBe(false);
    expect(await rewindToMessage(db, session.id, foreign.id)).toBe(false);
    expect(await getMessages(db, session.id)).toHaveLength(2);
    expect(await getMessages(db, other.id)).toHaveLength(1);
  });
});

describe("migration 0053", () => {
  const backfill = readFileSync(
    new URL("../../drizzle/0053_chat_titles_from_first_prompt.sql", import.meta.url),
    "utf8",
  );

  /** Stores a chat with these messages and no title, as one written before the migration. */
  async function oldChat(messages: Array<Partial<schema.NewChatMessage>>) {
    const session = await createSession(db);
    for (const m of messages) {
      await db.insert(schema.chatMessages).values({
        sessionId: session.id,
        role: "user",
        content: "",
        ...m,
      } as schema.NewChatMessage);
    }
    return session.id;
  }

  async function titleOf(id: string) {
    const [row] = await sql`SELECT title FROM chat_sessions WHERE id = ${id}`;
    return row!.title as string | null;
  }

  it("names old chats the way new ones are named", async () => {
    const prompts = [
      "\n   \n  Plan   my\tweek \nwith details",
      "x".repeat(PROMPT_TITLE_MAX),
      "x".repeat(PROMPT_TITLE_MAX + 1),
      `${"x".repeat(PROMPT_TITLE_MAX - 2)} yz`,
      `${"x".repeat(PROMPT_TITLE_MAX - 2)}🙂🙂🙂`,
    ];
    const ids = [];
    for (const content of prompts) ids.push(await oldChat([{ content }]));

    await sql.unsafe(backfill);

    for (const [i, id] of ids.entries()) {
      expect(await titleOf(id)).toBe(titleFromPrompt(prompts[i]!));
    }
  });

  it("uses the first user message and leaves chats it can't or mustn't name", async () => {
    const named = await oldChat([
      { role: "assistant", content: "Hi there" },
      { content: "First prompt" },
      { content: "Second prompt" },
    ]);
    const blank = await oldChat([{ content: "   " }]);
    const scheduled = await oldChat([
      {
        content: "Check CI",
        metadata: { scheduledTask: { id: "t1", attempt: 1, origin: "chat" } },
      },
    ]);
    const titled = (await createSession(db, "Kept")).id;
    await addMessage(db, { sessionId: titled, role: "user", content: "ignored" });

    await sql.unsafe(backfill);

    expect(await titleOf(named)).toBe("First prompt");
    expect(await titleOf(blank)).toBeNull();
    expect(await titleOf(scheduled)).toBeNull();
    expect(await titleOf(titled)).toBe("Kept");
  });
});
