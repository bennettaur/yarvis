import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { newAttentionState } from "../chat/attentionTools.ts";
import { buildBuiltinTools } from "../chat/builtinTools.ts";
import { getDb } from "../db/client.ts";
import { replyToQuestion } from "./service.ts";
import { buildQuestionTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

beforeEach(async () => {
  await sql`TRUNCATE agent_questions, attention_items RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const ASK = {
  task: "Planning your week",
  questions: [
    { question: "Should Friday stay meeting-free?", options: [{ label: "Yes" }, { label: "No" }] },
  ],
};

/** The tool call's options; only the abort signal is read. */
const callOptions = () =>
  ({ toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal }) as never;

const chatTools = (sessionId: string) => buildQuestionTools(db, sessionId);

async function pendingQuestionId(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const [row] = await sql<
      { id: string }[]
    >`SELECT id FROM agent_questions WHERE status = 'pending'`;
    if (row) return row.id;
    await Bun.sleep(20);
  }
  throw new Error("question never appeared");
}

describe("the in-app agent's question tools", () => {
  it("asks through the bell as Yarvis and returns the user's answer", async () => {
    const tools = chatTools("chat-1");
    const call = tools.ask_user.execute!(ASK, callOptions());
    const id = await pendingQuestionId();

    const [item] = await sql`SELECT source, session_key, title, nav_target FROM attention_items`;
    expect(item).toMatchObject({
      source: "chat-agent",
      session_key: "chat:chat-1",
      title: "Yarvis",
      nav_target: { type: "chat" },
    });

    await replyToQuestion(db, id, { status: "answered", answers: [{ selected: ["Yes"] }] });
    expect(await call).toEqual({
      status: "answered",
      answers: [{ question: "Should Friday stay meeting-free?", selected: ["Yes"] }],
    });
  });

  it("lets only the asking chat wait on its question", async () => {
    const call = chatTools("chat-1").ask_user.execute!(ASK, callOptions());
    const id = await pendingQuestionId();
    await replyToQuestion(db, id, { status: "declined" });
    await call;

    const other = chatTools("chat-2");
    expect(await other.wait_for_answer.execute!({ questionId: id }, callOptions())).toEqual({
      error: "No question with that id.",
    });
    const own = chatTools("chat-1");
    expect(await own.wait_for_answer.execute!({ questionId: id }, callOptions())).toMatchObject({
      status: "declined",
    });
  });

  it("stops waiting as soon as the chat turn is aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const call = chatTools("chat-1").ask_user.execute!(ASK, {
      toolCallId: "call-1",
      messages: [],
      abortSignal: controller.signal,
    } as never);
    const id = await pendingQuestionId();

    controller.abort();
    expect(await call).toMatchObject({ status: "pending", questionId: id });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("is offered only where the user can answer in the bell", () => {
    const toolsFor = (atTheApp: boolean) =>
      Object.keys(
        buildBuiltinTools({
          db,
          config: { secrets: {} } as never,
          sessionId: "chat-1",
          memory: undefined as never,
          attention: newAttentionState(),
          remoteControl: false,
          atTheApp,
        }),
      );
    expect(toolsFor(true)).toEqual(expect.arrayContaining(["ask_user", "wait_for_answer"]));
    // Telegram, a heads-down pass and a delegated run: a heads-down pass has its
    // own ask_user, which never waits, and must not share the name.
    expect(toolsFor(false)).not.toContain("ask_user");
    expect(toolsFor(false)).not.toContain("wait_for_answer");
  });
});
