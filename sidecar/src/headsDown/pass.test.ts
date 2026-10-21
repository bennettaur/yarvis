import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import postgres from "postgres";
import { listSessions } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { createStream, getStream } from "../workStreams/service.ts";
import { saveHeadsDownConfig } from "./config.ts";
import { runPass, STOPPED_BY_USER } from "./pass.ts";
import { addMessage, listPasses, startRun, unseenMessages } from "./service.ts";

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

/** A model whose steps are the given stream parts, one array per step. */
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

const toolCall = (id: string, name: string, input: unknown): StreamPart =>
  ({ type: "tool-call", toolCallId: id, toolName: name, input: JSON.stringify(input) }) as never;

const finish = (reason: "stop" | "tool-calls"): StreamPart =>
  ({ type: "finish", finishReason: { unified: reason, raw: undefined }, usage }) as never;

const workspaceId = "11111111-1111-4111-8111-111111111111";

let settingsDir: string;
const originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_messages, heads_down_questions, work_streams, chat_sessions, memories, events RESTART IDENTITY CASCADE`;
  settingsDir = mkdtempSync(join(tmpdir(), "heads-down-pass-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
  // Any time counts as working hours, so the sleep doesn't depend on when the test runs.
  await saveHeadsDownConfig({
    minSleepMinutes: 5,
    maxSleepMinutes: 120,
    idleSleepMinutes: 60,
    workingHours: null,
    userAwayAfterMinutes: 120,
    provider: null,
    model: null,
  });
});

afterAll(async () => {
  rmSync(settingsDir, { recursive: true, force: true });
  process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await sql.end();
});

describe("a heads-down pass", () => {
  it("asks without waiting, queues what needs approval, and ends with notes and a sleep", async () => {
    const run = await startRun(db, "ship billing");
    const stream = await createStream(db, { title: "ship billing" });
    await addMessage(db, "Prioritise the billing PR");
    const model = streamingModel(
      [
        toolCall("c1", "ask_user", {
          question: "Where should I ask for review?",
          situation: "The billing PR is ready",
          streamId: stream.id,
          options: ["#billing-reviews", "ask Sam"],
        }),
        toolCall("c2", "archive_workspace", { workspaceId, callReason: "the work is merged" }),
        toolCall("c3", "finish_pass", {
          notes: "Asked where to request review.",
          sleepMinutes: 10,
          reason: "waiting on the user",
        }),
        finish("tool-calls"),
      ],
      [finish("stop")],
    );

    const result = await runPass(config, db, run, { model });

    const questions =
      await sql`SELECT kind, action, status FROM heads_down_questions ORDER BY kind`;
    expect([...questions]).toEqual([
      expect.objectContaining({ kind: "question", status: "open" }),
      expect.objectContaining({ kind: "approval", action: "archive_workspace", status: "open" }),
    ]);
    expect((await getStream(db, stream.id))?.status).toBe("waiting-on-user");
    expect(await unseenMessages(db)).toEqual([]);

    const [pass] = await listPasses(db);
    expect(pass).toMatchObject({ notes: "Asked where to request review.", error: null });
    // Every stream now waits on the user, so it sleeps at least the idle time.
    expect(result.sleepMinutes).toBe(60);
    expect(result.sleepReason).toContain("every stream is waiting");
    // The pass's transcript is a hidden session, kept out of the chat list.
    expect(await listSessions(db)).toEqual([]);
  });

  it("records a pass that ended without finish_pass as an error, and sleeps as if idle", async () => {
    const run = await startRun(db, null);
    await createStream(db, { title: "ship billing" });

    const result = await runPass(config, db, run, { model: streamingModel([finish("stop")]) });

    const [pass] = await listPasses(db);
    expect(pass?.error).toBeString();
    expect(result.sleepMinutes).toBe(60);
  });

  it("records a pass for a run already stopped as stopped by the user, not failed", async () => {
    const run = await startRun(db, null);
    await sql`UPDATE heads_down_runs SET status = 'stopped', stopped_at = now()`;

    const result = await runPass(config, db, run, { model: streamingModel([finish("stop")]) });

    const [pass] = await listPasses(db);
    expect(pass?.error).toBeNull();
    expect(result.sleepReason).toBe(STOPPED_BY_USER);
  });
});
