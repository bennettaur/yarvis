import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import { type AgentEvent, runAgentTurn } from "./agent.ts";
import { createSession, getMessages } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const { db } = getDb(url);

const config: Config = {
  port: 0,
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

type DoStream = NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]>["doStream"];
type StreamResult = Awaited<ReturnType<Extract<DoStream, (...args: never[]) => unknown>>>;
type StreamPart = StreamResult extends { stream: ReadableStream<infer P> } ? P : never;

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * A model whose turn is the given stream parts. Passing several arrays gives one
 * per step, which is what a turn with tool calls in it takes: the SDK asks the
 * model again once it has the results.
 */
function streamingModel(...steps: StreamPart[][]): MockLanguageModelV3 {
  let call = 0;
  return new MockLanguageModelV3({
    doStream: async () => {
      const parts = steps[Math.min(call++, steps.length - 1)] ?? [];
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  });
}

/** A tool call as a provider emits it: the arguments arrive as a JSON string. */
const toolCall = (id: string, name: string, input: unknown): StreamPart =>
  ({
    type: "tool-call",
    toolCallId: id,
    toolName: name,
    input: JSON.stringify(input),
  }) as unknown as StreamPart;

const finish = (reason: "stop" | "tool-calls"): StreamPart =>
  ({
    type: "finish",
    finishReason: { unified: reason, raw: undefined },
    usage,
  }) as unknown as StreamPart;

const text = (value: string): StreamPart[] =>
  [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: value },
    { type: "text-end", id: "t1" },
  ] as unknown as StreamPart[];

const serverNames = new Map([["server-uuid", "Notion"]]);

/** Denies every approval request, as a user pressing Deny would. */
const denyingApproval = {
  onRequest: async ({ toolCallId }: { toolCallId: string }) => {
    resolveApproval(toolCallId, false);
  },
};

async function collect(
  model: MockLanguageModelV3,
  sessionId: string,
  approval?: { onRequest: (info: { toolCallId: string }) => Promise<void> },
  signal?: AbortSignal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgentTurn({
    config,
    db,
    model,
    sessionId,
    message: "hi",
    serverNames,
    approval,
    signal,
  })) {
    events.push(event);
  }
  return events;
}

beforeEach(async () => {
  await sql`TRUNCATE chat_messages, chat_sessions, agent_tools RESTART IDENTITY CASCADE`;
  // Only tools the registry marks "always" are offered to the model each step,
  // and nothing has synced the built-ins into this database. Register the two
  // these tests drive.
  for (const name of ["list_tasks", "create_calendar_event"]) {
    await sql`
      INSERT INTO agent_tools (id, source, server_id, name, description, policy, content_hash)
      VALUES (${`builtin:${name}`}, 'builtin', NULL, ${name}, '', 'always', '')
    `;
  }
});

afterAll(async () => {
  await sql.end();
});

describe("runAgentTurn", () => {
  it("streams and persists a reply", async () => {
    const session = await createSession(db, null);
    const events = await collect(streamingModel([...text("hello"), finish("stop")]), session.id);

    expect(events.filter((e) => e.type === "delta").map((e) => e.text)).toEqual(["hello"]);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ text: "hello", finishReason: "stop" });
    const stored = await getMessages(db, session.id);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  // A turn that spends its last step on a tool call used to persist an empty
  // assistant row and end silently, which is what "the chat just stopped"
  // looked like from the outside.
  it("explains a turn that ended with no reply, and persists nothing for it", async () => {
    const session = await createSession(db, null);
    const events = await collect(streamingModel([finish("tool-calls")]), session.id);

    const error = events.find((e) => e.type === "error");
    expect(error?.message).toContain("ran out of steps");
    expect(events.some((e) => e.type === "done")).toBe(false);
    const stored = await getMessages(db, session.id);
    expect(stored.map((m) => m.role)).toEqual(["user"]);
  });

  it("reports each tool call and its outcome, and persists them with the reply", async () => {
    const session = await createSession(db, null);
    const events = await collect(
      streamingModel(
        [toolCall("c1", "list_tasks", { scope: "daily" }), finish("tool-calls")],
        [...text("done"), finish("stop")],
      ),
      session.id,
    );

    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ id: "c1", name: "list_tasks", args: { scope: "daily" } });

    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ id: "c1", status: "ok" });
    expect(result?.durationMs).toBeGreaterThanOrEqual(0);

    const [, assistant] = await getMessages(db, session.id);
    expect(assistant?.toolCalls?.map((a) => [a.name, a.status])).toEqual([["list_tasks", "ok"]]);
  });

  // A denial comes back to the model as a normal result so it can move on, but
  // for the user it is the outcome that matters most and must not read as a
  // successful call.
  it("marks a denied tool call as denied rather than as a result", async () => {
    const session = await createSession(db, null);
    const events = await collect(
      streamingModel(
        [
          toolCall("c1", "create_calendar_event", {
            title: "sync",
            start: "2026-01-01T10:00:00Z",
            end: "2026-01-01T10:30:00Z",
          }),
          finish("tool-calls"),
        ],
        [...text("told them no"), finish("stop")],
      ),
      session.id,
      denyingApproval,
    );

    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ status: "denied" });
    const [, assistant] = await getMessages(db, session.id);
    expect(assistant?.toolCalls?.map((a) => a.status)).toEqual(["denied"]);
  });

  it("names the MCP server a tool belongs to", async () => {
    const session = await createSession(db, null);
    const events = await collect(
      streamingModel(
        [toolCall("c1", "mcp:server-uuid:search_pages", { query: "notion" }), finish("tool-calls")],
        [...text("done"), finish("stop")],
      ),
      session.id,
    );

    // The model-facing key of an MCP tool is its registry id; only the tool's
    // own name means anything to a reader.
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      name: "search_pages",
      server: "Notion",
    });
  });

  // The turn changed things outside this app. Losing that record is what makes
  // a retry do all of it a second time.
  it("records what an out-of-steps turn already ran", async () => {
    const session = await createSession(db, null);
    await collect(
      streamingModel(
        [toolCall("c1", "list_tasks", {}), finish("tool-calls")],
        [toolCall("c2", "list_tasks", {}), finish("tool-calls")],
      ),
      session.id,
    );

    const [, assistant] = await getMessages(db, session.id);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toContain("ran out of steps");
    expect(assistant?.toolCalls?.length).toBeGreaterThan(0);
  });

  // The surface that stopped the turn has already dropped its partial reply;
  // persisting it here would put a message in the transcript the user was told
  // did not exist.
  it("saves nothing for a turn the user stopped", async () => {
    const session = await createSession(db, null);
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        controller.abort();
        return {
          stream: new ReadableStream<StreamPart>({
            start(c) {
              for (const part of text("half a th")) c.enqueue(part);
              c.close();
            },
          }),
        };
      },
    });

    const events = await collect(model, session.id, undefined, controller.signal);
    expect(events.find((e) => e.type === "error")?.message).toContain("Turn stopped");
    expect((await getMessages(db, session.id)).map((m) => m.role)).toEqual(["user"]);
  });

  it("streams reasoning separately from the reply", async () => {
    const session = await createSession(db, null);
    const events = await collect(
      streamingModel([
        { type: "reasoning-start", id: "r1" } as unknown as StreamPart,
        { type: "reasoning-delta", id: "r1", delta: "weighing it up" } as unknown as StreamPart,
        ...text("answer"),
        finish("stop"),
      ]),
      session.id,
    );

    expect(events.filter((e) => e.type === "reasoning").map((e) => e.text)).toEqual([
      "weighing it up",
    ]);
    // Reasoning is not part of the reply, and is not persisted with it.
    const [, assistant] = await getMessages(db, session.id);
    expect(assistant?.content).toBe("answer");
  });

  // Retrying a failed turn re-sends the same text. The failed turn already
  // persisted it, so recording it twice would leave the thread asking twice —
  // and every later replay of that thread with it.
  it("treats a resend of the last user message as the same turn", async () => {
    const session = await createSession(db, null);
    await collect(streamingModel([finish("tool-calls")]), session.id);
    expect((await getMessages(db, session.id)).map((m) => m.role)).toEqual(["user"]);

    await collect(streamingModel([...text("second time lucky"), finish("stop")]), session.id);
    const stored = await getMessages(db, session.id);
    expect(stored.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored[1]?.content).toBe("second time lucky");
  });

  it("reports a provider failure with a detail worth reading", async () => {
    const session = await createSession(db, null);
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw Object.assign(new Error("model not found"), {
          statusCode: 404,
          url: "https://gateway.internal/v1/responses",
          responseBody: '{"error":"no such model"}',
        });
      },
    });
    const events = await collect(model, session.id);

    const error = events.find((e) => e.type === "error");
    expect(error?.message).toBe("model not found (status 404)");
    expect(error?.detail).toContain("no such model");
    expect(error?.detail).toContain("gateway.internal");
  });
});
