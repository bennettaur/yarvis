import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { selectTools } from "../agents/run.ts";
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

const chatTools = (sessionId: string) => buildQuestionTools(db, sessionId, { atTheApp: true });

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

  it("tells the agent to ask in its reply when the user is away from the app", async () => {
    const away = buildQuestionTools(db, "chat-1", { atTheApp: false });
    expect(await away.ask_user.execute!(ASK, callOptions())).toMatchObject({
      error: expect.stringContaining("Ask in your reply"),
    });
    expect(await sql`SELECT id FROM agent_questions`).toHaveLength(0);
  });

  it("is never handed to a delegated run, even one that names it", () => {
    const all = { ...chatTools("chat-1"), recall: chatTools("chat-1").ask_user };
    const selected = selectTools(all, [
      "builtin:ask_user",
      "builtin:wait_for_answer",
      "builtin:recall",
    ]);
    expect(Object.keys(selected)).toEqual(["recall"]);
  });
});
