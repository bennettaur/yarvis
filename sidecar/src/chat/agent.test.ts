import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
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

/** A model whose whole turn is the given stream parts. */
function streamingModel(parts: StreamPart[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
}

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

async function collect(model: MockLanguageModelV3, sessionId: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runAgentTurn({ config, db, model, sessionId, message: "hi" })) {
    events.push(event);
  }
  return events;
}

beforeEach(async () => {
  await sql`TRUNCATE chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
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
