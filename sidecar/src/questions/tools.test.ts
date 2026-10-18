import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { alwaysOnBuiltinToolNames } from "../agentTools/registry.ts";
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
    const tools = buildQuestionTools(db, "chat-1");
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
    const call = buildQuestionTools(db, "chat-1").ask_user.execute!(ASK, callOptions());
    const id = await pendingQuestionId();
    await replyToQuestion(db, id, { status: "declined" });
    await call;

    const other = buildQuestionTools(db, "chat-2");
    expect(await other.wait_for_answer.execute!({ questionId: id }, callOptions())).toEqual({
      error: "No question with that id.",
    });
    const own = buildQuestionTools(db, "chat-1");
    expect(await own.wait_for_answer.execute!({ questionId: id }, callOptions())).toMatchObject({
      status: "declined",
    });
  });

  it("is left out of a scheduled job's default tools", () => {
    const names = alwaysOnBuiltinToolNames();
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("wait_for_answer");
  });
});
