import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 8765,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);

const bearer = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

const workspaceId = "11111111-1111-1111-1111-111111111111";
const sessionKey = `ws-claude:${workspaceId}`;

beforeEach(async () => {
  await sql`TRUNCATE agent_questions, attention_items, workspaces RESTART IDENTITY CASCADE`;
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${workspaceId}, 'Fix the API', 'fix-the-api', 'active', '/tmp/ws')`;
});

afterAll(async () => {
  await sql.end();
});

/** Calls an MCP tool the way a workspace's Claude session would, headers included. */
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-mcp-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "127.0.0.1:8765",
      "X-Yarvis-Session-Key": sessionKey,
      "X-Yarvis-Workspace-Id": workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return { isError: body.result.isError, value: JSON.parse(body.result.content[0]?.text ?? "{}") };
}

const ASK = {
  task: "Adding rate limiting to the public API",
  reason: "Two reasonable limits; the choice changes the config shape",
  questions: [
    {
      question: "Which limiter should the API use?",
      header: "Limiter",
      options: [{ label: "Token bucket" }, { label: "Fixed window" }],
    },
    { question: "Anything else I should know?" },
  ],
};

/** Waits for the blocked `ask_user` call to have stored its question. */
async function pendingQuestionId(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/api/questions?sessionKey=${encodeURIComponent(sessionKey)}`, {
      headers: bearer,
    });
    const rows = (await res.json()) as { id: string }[];
    if (rows[0]) return rows[0].id;
    await Bun.sleep(20);
  }
  throw new Error("question never appeared");
}

describe("ask_user over MCP", () => {
  it("raises a question in the attention stream and returns the user's answers", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();

    const [item] = await sql`SELECT kind, status, title, workspace_id FROM attention_items`;
    expect(item).toMatchObject({
      kind: "question",
      status: "pending",
      title: "Fix the API",
      workspace_id: workspaceId,
    });

    const question = (await (
      await app.request(`/api/questions/${id}`, { headers: bearer })
    ).json()) as { context: unknown };
    expect(question.context).toEqual({ task: ASK.task, reason: ASK.reason });

    const answered = await app.request(`/api/questions/${id}/answer`, {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({
        answers: [{ selected: ["Token bucket"] }, { selected: [], text: "Keep it per-user" }],
      }),
    });
    expect(answered.status).toBe(200);

    const { value } = await call;
    expect(value).toEqual({
      status: "answered",
      answers: [
        { question: "Which limiter should the API use?", selected: ["Token bucket"] },
        { question: "Anything else I should know?", selected: [], text: "Keep it per-user" },
      ],
    });

    const [after] = await sql`SELECT status FROM attention_items`;
    expect(after?.status).toBe("resolved");
  });

  it("tells the agent when the user declines", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    const res = await app.request(`/api/questions/${id}/decline`, {
      method: "POST",
      headers: bearer,
    });
    expect(res.status).toBe(200);
    expect((await call).value.status).toBe("declined");

    const again = await app.request(`/api/questions/${id}/decline`, {
      method: "POST",
      headers: bearer,
    });
    expect(again.status).toBe(409);
  });

  it("rejects answers that don't fit the questions", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    const answer = (answers: unknown) =>
      app.request(`/api/questions/${id}/answer`, {
        method: "POST",
        headers: bearer,
        body: JSON.stringify({ answers }),
      });

    expect((await answer([{ selected: ["Token bucket"] }])).status).toBe(400);
    expect(
      (await answer([{ selected: ["Leaky bucket"] }, { selected: [], text: "x" }])).status,
    ).toBe(400);
    expect(
      (await answer([{ selected: ["Token bucket", "Fixed window"] }, { selected: [], text: "x" }]))
        .status,
    ).toBe(400);
    expect((await answer([{ selected: ["Token bucket"] }, { selected: [] }])).status).toBe(400);

    await app.request(`/api/questions/${id}/decline`, { method: "POST", headers: bearer });
    await call;
  });

  it("keeps a question pending when its session is marked read on view", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();

    const cleared = await app.request("/api/attention/clear", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ sessionKey, status: "read" }),
    });
    expect(await cleared.json()).toEqual([]);

    await app.request(`/api/questions/${id}/decline`, { method: "POST", headers: bearer });
    await call;
  });

  it("returns an answer already given to wait_for_answer without waiting", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    await app.request(`/api/questions/${id}/decline`, { method: "POST", headers: bearer });
    await call;

    const { value } = await callTool("wait_for_answer", { questionId: id });
    expect(value.status).toBe("declined");
  });
});
