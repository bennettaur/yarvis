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

interface Origin {
  sessionKey?: string;
  workspaceId?: string;
}

/**
 * Calls an MCP tool the way a workspace's Claude session would, headers
 * included. Pass an origin to ask as another session, or `{}` for a client
 * Yarvis didn't launch.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  origin: Origin = { sessionKey, workspaceId },
) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-mcp-token",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: "127.0.0.1:8765",
      ...(origin.sessionKey ? { "X-Yarvis-Session-Key": origin.sessionKey } : {}),
      ...(origin.workspaceId ? { "X-Yarvis-Workspace-Id": origin.workspaceId } : {}),
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
  const text = body.result.content[0]?.text ?? "{}";
  // Failures come back as plain text rather than JSON.
  return { isError: body.result.isError, value: body.result.isError ? text : JSON.parse(text) };
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

/** Waits for blocked `ask_user` calls to have stored `count` pending questions, oldest first. */
async function pendingQuestionIds(count = 1): Promise<string[]> {
  for (let i = 0; i < 100; i++) {
    const rows = await sql<{ id: string }[]>`
      SELECT id FROM agent_questions WHERE status = 'pending' ORDER BY created_at`;
    if (rows.length >= count) return rows.map((r) => r.id);
    await Bun.sleep(20);
  }
  throw new Error("questions never appeared");
}

async function pendingQuestionId(): Promise<string> {
  return (await pendingQuestionIds())[0]!;
}

const answer = (id: string, answers: unknown) =>
  app.request(`/api/questions/${id}/answer`, {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({ answers }),
  });

const decline = (id: string) =>
  app.request(`/api/questions/${id}/decline`, { method: "POST", headers: bearer });

describe("ask_user over MCP", () => {
  it("raises a question in the attention stream and returns the user's answers", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();

    const [item] = await sql`SELECT source, kind, status, title, workspace_id FROM attention_items`;
    expect(item).toMatchObject({
      source: "system",
      kind: "question",
      status: "pending",
      title: "Fix the API",
      workspace_id: workspaceId,
    });

    const question = (await (
      await app.request(`/api/questions/${id}`, { headers: bearer })
    ).json()) as { context: unknown };
    expect(question.context).toEqual({ task: ASK.task, reason: ASK.reason });

    const answered = await answer(id, [
      { selected: ["Token bucket"] },
      { selected: [], text: "Keep it per-user" },
    ]);
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
    const res = await decline(id);
    expect(res.status).toBe(200);
    expect((await call).value.status).toBe("declined");

    const again = await decline(id);
    expect(again.status).toBe(409);
  });

  it("rejects answers that don't fit the questions", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    const status = async (answers: unknown) => (await answer(id, answers)).status;

    expect(await status([{ selected: ["Token bucket"] }])).toBe(400);
    expect(await status([{ selected: ["Leaky bucket"] }, { selected: [], text: "x" }])).toBe(400);
    expect(
      await status([{ selected: ["Token bucket", "Fixed window"] }, { selected: [], text: "x" }]),
    ).toBe(400);
    expect(await status([{ selected: ["Token bucket"] }, { selected: [] }])).toBe(400);

    await decline(id);
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

    await decline(id);
    await call;
  });

  it("returns an answer already given to wait_for_answer without waiting", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    await decline(id);
    await call;

    const { value } = await callTool("wait_for_answer", { questionId: id });
    expect(value.status).toBe("declined");
  });

  it("keeps a session's bell up until its last question is answered", async () => {
    const first = callTool("ask_user", ASK);
    await pendingQuestionIds(1);
    const second = callTool("ask_user", { ...ASK, task: "A second question" });
    const [firstId, secondId] = await pendingQuestionIds(2);

    const listed = await app.request(
      `/api/questions?sessionKey=${encodeURIComponent(sessionKey)}`,
      { headers: bearer },
    );
    expect(((await listed.json()) as { id: string }[]).map((q) => q.id)).toEqual([
      firstId!,
      secondId!,
    ]);
    // Both questions share the session's one attention item.
    expect(await sql`SELECT id FROM attention_items`).toHaveLength(1);

    await decline(firstId!);
    await first;
    const [stillUp] = await sql`SELECT status FROM attention_items`;
    expect(stillUp?.status).toBe("pending");

    await decline(secondId!);
    await second;
    const [cleared] = await sql`SELECT status FROM attention_items`;
    expect(cleared?.status).toBe("resolved");
  });

  it("clears a question from a client Yarvis didn't launch by its own id", async () => {
    const call = callTool("ask_user", ASK, {});
    const id = await pendingQuestionId();

    const [item] =
      await sql`SELECT session_key, workspace_id, title, nav_target FROM attention_items`;
    expect(item).toMatchObject({
      session_key: null,
      workspace_id: null,
      title: "Claude session",
      nav_target: null,
    });

    await decline(id);
    expect((await call).value.status).toBe("declined");
    const [after] = await sql`SELECT status FROM attention_items`;
    expect(after?.status).toBe("resolved");
  });

  it("drops a workspace header that names no workspace", async () => {
    const call = callTool("ask_user", ASK, {
      sessionKey: "terminal/t1/p1",
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
    const id = await pendingQuestionId();
    const [question] = await sql`SELECT workspace_id FROM agent_questions`;
    expect(question?.workspace_id).toBeNull();

    await decline(id);
    await call;
  });

  it("refuses duplicate option labels", async () => {
    const { isError } = await callTool("ask_user", {
      ...ASK,
      questions: [{ question: "Which?", options: [{ label: "Same" }, { label: "Same" }] }],
    });
    expect(isError).toBe(true);
    expect(await sql`SELECT id FROM agent_questions`).toHaveLength(0);
  });

  it("only lets the asking session wait on its question", async () => {
    const call = callTool("ask_user", ASK);
    const id = await pendingQuestionId();
    await decline(id);
    await call;

    const other = await callTool(
      "wait_for_answer",
      { questionId: id },
      { sessionKey: "ws-claude:someone-else" },
    );
    expect(other).toEqual({ isError: true, value: "No question with that id." });

    const unknown = await callTool("wait_for_answer", {
      questionId: "33333333-3333-3333-3333-333333333333",
    });
    expect(unknown.isError).toBe(true);
  });
});
