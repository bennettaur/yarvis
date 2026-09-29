import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import postgres from "postgres";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import { modelToolKey } from "../mcp/chatTools.ts";
import type { McpClientTool } from "../mcp/connectionManager.ts";
import { type AgentEvent, runAgentTurn } from "./agent.ts";
import { addMessage, createSession, getMessages } from "./service.ts";

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
  budget?: { maxSteps?: number; maxOutputTokens?: number | null; compactAtTokens?: number },
  liveTools?: Record<string, McpClientTool>,
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
    budget,
    liveTools,
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

  // The number in that message is the budget the turn actually ran with, not a
  // constant — otherwise it sends the user to raise a limit they already raised.
  it("names the configured step limit when a turn runs out of steps", async () => {
    const session = await createSession(db, null);
    const events = await collect(
      streamingModel([finish("tool-calls")]),
      session.id,
      undefined,
      undefined,
      {
        maxSteps: 37,
      },
    );

    expect(events.find((e) => e.type === "error")?.message).toContain("37-step limit");
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
    const id = "mcp:server-uuid:search_pages";
    await sql`
      INSERT INTO agent_tools (id, source, server_id, name, description, policy, content_hash)
      VALUES (${id}, 'mcp', NULL, 'search_pages', '', 'always', '')
    `;
    const liveTools = {
      [id]: tool({
        description: "search_pages",
        inputSchema: z.object({ query: z.string() }),
        execute: async () => ({ pages: [] }),
      }) as unknown as McpClientTool,
    };
    const events = await collect(
      streamingModel(
        [toolCall("c1", modelToolKey(id), { query: "notion" }), finish("tool-calls")],
        [...text("done"), finish("stop")],
      ),
      session.id,
      // MCP tools are only offered to a turn that has an approval channel.
      denyingApproval,
      undefined,
      undefined,
      liveTools,
    );

    // The model calls the tool by a provider-safe key; the reader sees the
    // tool's own name and the server it lives on.
    expect(events.find((e) => e.type === "tool_call")).toMatchObject({
      name: "search_pages",
      server: "Notion",
    });
    // Denied proves the key reached the approval-wrapped MCP tool.
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ status: "denied" });
  });

  // Bedrock rejects the whole turn over one tool name it can't accept (#321).
  it("offers every tool to the provider under a name it accepts", async () => {
    const session = await createSession(db, null);
    const serverId = "907bd56b-f417-419e-92db-2f1e4e1aa0ce";
    const id = `mcp:${serverId}:github__update_pull_request`;
    await sql`
      INSERT INTO agent_tools (id, source, server_id, name, description, policy, content_hash)
      VALUES (${id}, 'mcp', ${serverId}, 'github__update_pull_request', '', 'always', '')
    `;
    const liveTools = {
      [id]: tool({
        description: "github__update_pull_request",
        inputSchema: z.object({}),
        execute: async () => ({}),
      }) as unknown as McpClientTool,
    };
    const model = streamingModel([...text("done"), finish("stop")]);

    await collect(model, session.id, denyingApproval, undefined, undefined, liveTools);

    const offered = (model.doStreamCalls[0]?.tools ?? []).map((t) => t.name);
    expect(offered).toContain(modelToolKey(id));
    expect(offered.every((name) => /^[A-Za-z0-9_-]{1,64}$/.test(name))).toBe(true);
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

  describe("compaction", () => {
    /** One model for both jobs: `doGenerate` writes the summary, `doStream` the reply. */
    function chatAndSummarizer(summary: string, reply = "ok") {
      const model = streamingModel([...text(reply), finish("stop")]);
      model.doGenerate = async () => ({
        content: [{ type: "text", text: summary }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      });
      return model;
    }

    async function seedLongSession(): Promise<string> {
      const session = await createSession(db, "long");
      for (let i = 0; i < 16; i++) {
        await addMessage(db, {
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          // 16 x 60k chars is about 240k tokens, past the default compaction threshold.
          content: `m${i} ${"x".repeat(60_000)}`,
        });
      }
      return session.id;
    }

    it("summarizes a long history before the turn and replays the summary", async () => {
      const sessionId = await seedLongSession();
      const model = chatAndSummarizer("They talked about x.");
      const events = await collect(model, sessionId);
      expect(events.at(-1)?.type).toBe("done");

      const rows = await getMessages(db, sessionId);
      expect(rows.filter((m) => m.role === "system")).toHaveLength(1);

      const prompt = JSON.stringify(model.doStreamCalls[0]?.prompt);
      expect(prompt).toContain("They talked about x.");
      expect(prompt).not.toContain("m0 ");
      // The current message is sent once.
      expect(prompt.match(/"text":"hi"/g)).toHaveLength(1);
    });

    it("compacts at the configured threshold rather than the default", async () => {
      const session = await createSession(db, "small");
      for (let i = 0; i < 12; i++) {
        await addMessage(db, {
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `m${i} ${"x".repeat(10_000)}`,
        });
      }
      // About 30k tokens: far under the 200k default, over a 10k setting.
      const model = chatAndSummarizer("Lower threshold summary.");
      await collect(model, session.id, undefined, undefined, { compactAtTokens: 10_000 });
      expect((await getMessages(db, session.id)).some((m) => m.role === "system")).toBe(true);
    });

    it("leaves a history under a raised threshold alone", async () => {
      const sessionId = await seedLongSession();
      const model = chatAndSummarizer("unused");
      await collect(model, sessionId, undefined, undefined, { compactAtTokens: 1_000_000 });
      expect((await getMessages(db, sessionId)).some((m) => m.role === "system")).toBe(false);
      expect(model.doGenerateCalls).toHaveLength(0);
    });

    it("still answers from the full history when the summarizer fails", async () => {
      const sessionId = await seedLongSession();
      const model = streamingModel([...text("ok"), finish("stop")]);
      model.doGenerate = async () => {
        throw new Error("boom");
      };
      const events = await collect(model, sessionId);
      expect(events.at(-1)?.type).toBe("done");
      expect((await getMessages(db, sessionId)).some((m) => m.role === "system")).toBe(false);
    });

    it("does not duplicate a resent message when a summary follows it", async () => {
      const session = await createSession(db, "retry");
      await addMessage(db, { sessionId: session.id, role: "user", content: "hi" });
      const first = (await getMessages(db, session.id))[0]!;
      await addMessage(db, {
        sessionId: session.id,
        role: "system",
        content: "summary",
        metadata: { compaction: { throughMessageId: first.id } },
      });

      await collect(streamingModel([...text("ok"), finish("stop")]), session.id);
      const users = (await getMessages(db, session.id)).filter((m) => m.role === "user");
      expect(users).toHaveLength(1);
    });

    it("compacts after a context-window error so a retry can go through", async () => {
      const session = await createSession(db, "overflow");
      for (let i = 0; i < 12; i++) {
        await addMessage(db, {
          sessionId: session.id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i} ${"y".repeat(500)}`,
        });
      }
      const model = new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("prompt is too long: 1152621 tokens > 1000000 maximum");
        },
        doGenerate: async () => ({
          content: [{ type: "text", text: "short" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        }),
      });
      const events = await collect(model, session.id);
      const error = events.find((e) => e.type === "error");
      expect(error?.type === "error" && error.message).toContain("summarized");
      expect((await getMessages(db, session.id)).some((m) => m.role === "system")).toBe(true);
    });
  });
});
