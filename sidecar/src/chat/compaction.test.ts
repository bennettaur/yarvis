import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { MockLanguageModelV3 } from "ai/test";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import type { ChatMessage } from "../db/schema.ts";
import {
  compactSession,
  estimateTokens,
  isContextWindowError,
  selectReplay,
  summaryMessage,
} from "./compaction.ts";
import { addMessage, createSession, getMessages } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const { db } = getDb(url);

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

function row(id: string, role: ChatMessage["role"], content: string, metadata = null) {
  return { id, role, content, metadata, sessionId: "s", toolCalls: null, createdAt: new Date() };
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function summarizer(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

describe("selectReplay", () => {
  it("replays every user and assistant message when never compacted", () => {
    const replay = selectReplay([row("1", "user", "a"), row("2", "assistant", "b")]);
    expect(replay.summary).toBeNull();
    expect(replay.live.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("resumes after the last message the summary covers", () => {
    const replay = selectReplay([
      row("1", "user", "a"),
      row("2", "assistant", "b"),
      row("3", "user", "c"),
      row("s", "system", "the summary", { compaction: { throughMessageId: "2" } } as never),
    ]);
    expect(replay.summary).toBe("the summary");
    expect(replay.live.map((m) => m.id)).toEqual(["3"]);
  });

  it("ignores a summary whose covered message is gone", () => {
    const replay = selectReplay([
      row("1", "user", "a"),
      row("s", "system", "orphan", { compaction: { throughMessageId: "missing" } } as never),
    ]);
    expect(replay.summary).toBeNull();
    expect(replay.live.map((m) => m.id)).toEqual(["1"]);
  });
});

describe("helpers", () => {
  it("estimates about four characters a token", () => {
    expect(estimateTokens([{ content: "a".repeat(400) }])).toBe(100);
  });

  it("fences the summary as data", () => {
    const msg = summaryMessage("done X", "abc");
    expect(msg.role).toBe("user");
    expect(msg.content).toContain(
      "<conversation-summary-abc>\ndone X\n</conversation-summary-abc>",
    );
  });

  it("recognises the Bedrock context-window error", () => {
    expect(isContextWindowError("prompt is too long: 1152621 tokens > 1000000 maximum")).toBe(true);
    expect(isContextWindowError("rate limited")).toBe(false);
  });
});

describe("compactSession", () => {
  async function seed(count: number) {
    const session = await createSession(db, "long");
    for (let i = 0; i < count; i++) {
      await addMessage(db, {
        sessionId: session.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
      });
    }
    return session.id;
  }

  it("does nothing while the history is under the threshold", async () => {
    const sessionId = await seed(10);
    const history = await getMessages(db, sessionId);
    const done = await compactSession({ db, model: summarizer("s"), sessionId, history });
    expect(done).toBe(false);
    expect(await getMessages(db, sessionId)).toHaveLength(10);
  });

  it("stores a summary covering all but the most recent messages", async () => {
    const sessionId = await seed(10);
    const history = await getMessages(db, sessionId);
    const done = await compactSession({
      db,
      model: summarizer("They discussed X."),
      sessionId,
      history,
      thresholdTokens: 1,
    });
    expect(done).toBe(true);

    const replay = selectReplay(await getMessages(db, sessionId));
    expect(replay.summary).toBe("They discussed X.");
    expect(replay.live.map((m) => m.content)).toEqual([
      "message 4",
      "message 5",
      "message 6",
      "message 7",
      "message 8",
      "message 9",
    ]);
  });

  it("leaves the history alone when the summarizer fails", async () => {
    const sessionId = await seed(10);
    const history = await getMessages(db, sessionId);
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const done = await compactSession({ db, model, sessionId, history, force: true });
    expect(done).toBe(false);
    expect(await getMessages(db, sessionId)).toHaveLength(10);
  });
});
