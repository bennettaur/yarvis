import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import { addMessage as addChatMessage, createSession } from "../chat/service.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { CUT_SHORT_RESULT } from "../db/schema.ts";
import { createStream } from "../workStreams/service.ts";
import { askUser } from "./attention.ts";
import { startPass, startRun } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

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
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

const post = (path: string, body?: unknown) =>
  app.request(`/api/heads-down${path}`, {
    method: "POST",
    headers: jsonAuth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
// biome-ignore lint/suspicious/noExplicitAny: test reads of JSON bodies
const get = async (path: string): Promise<any> =>
  (await app.request(`/api/heads-down${path}`, { headers: auth })).json();

/** A finished pass of the active run that chose to sleep `minutes`. */
async function seedFinishedPass(minutes: number) {
  await sql`INSERT INTO heads_down_passes (run_id, finished_at, sleep_minutes)
            SELECT id, now(), ${minutes} FROM heads_down_runs WHERE status = 'active'`;
}

let settingsDir: string;
const originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_messages, work_streams, heads_down_questions, attention_items, memories, events RESTART IDENTITY CASCADE`;
  settingsDir = mkdtempSync(join(tmpdir(), "heads-down-routes-"));
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterAll(async () => {
  rmSync(settingsDir, { recursive: true, force: true });
  process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await sql.end();
});

describe("/api/heads-down", () => {
  it("turns heads-down mode on and off", async () => {
    expect((await post("/start", { focus: "ship billing" })).status).toBe(200);
    expect(await get("")).toMatchObject({ run: { focus: "ship billing", status: "active" } });

    await askUser(db, { kind: "question", question: "Which repo?" });
    await post("/stop");
    expect(await get("")).toMatchObject({ run: null });
    // Nothing is left in the bell asking for an answer no pass will read.
    expect(await get("/questions")).toEqual([]);
    const items = await sql`SELECT status FROM attention_items`;
    expect(items.map((r) => r.status)).toEqual(["resolved"]);
  });

  it("pauses and resumes without dropping the questions it asked", async () => {
    expect((await post("/pause")).status).toBe(409);
    await post("/start", {});
    await askUser(db, { kind: "question", question: "Which repo?" });
    await seedFinishedPass(30);
    expect((await get("")).nextPassAt).toBeString();
    expect((await post("/resume")).status).toBe(409);

    expect((await post("/pause")).status).toBe(200);
    // No pass is due while paused.
    expect(await get("")).toMatchObject({ run: { status: "active" }, nextPassAt: null });
    expect((await get("")).run.pausedAt).not.toBeNull();
    expect(await get("/questions")).toEqual([expect.objectContaining({ question: "Which repo?" })]);

    expect((await post("/resume")).status).toBe(200);
    expect(await get("")).toMatchObject({ run: { pausedAt: null } });
  });

  it("shows no next pass when the run stops before it", async () => {
    await post("/start", { stopAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    await seedFinishedPass(30);
    expect((await get("")).nextPassAt).toBeNull();
  });

  it("sets and clears the stop time, and refuses one already passed", async () => {
    const put = (body: unknown) =>
      app.request("/api/heads-down/stop-at", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });
    const later = new Date(Date.now() + 60 * 60_000).toISOString();
    expect((await put({ stopAt: later })).status).toBe(409);

    expect(
      (await post("/start", { stopAt: new Date(Date.now() - 60_000).toISOString() })).status,
    ).toBe(400);
    expect((await post("/start", { stopAt: "7pm" })).status).toBe(400);
    expect((await post("/start", { stopAt: later })).status).toBe(200);
    expect(await get("")).toMatchObject({ run: { stopAt: later } });
    expect((await put({ stopAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    expect((await put({ stopAt: null })).status).toBe(200);
    expect(await get("")).toMatchObject({ run: { stopAt: null } });
    // A local time is its next occurrence.
    expect((await put({ stopAt: "23:59" })).status).toBe(200);
    expect(new Date((await get("")).run.stopAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("takes a message for the next pass, and refuses an empty one", async () => {
    expect((await post("/messages", { body: "Send Alex the PR link" })).status).toBe(201);
    expect((await post("/messages", { body: "  " })).status).toBe(400);
    expect(await get("/messages")).toEqual([
      expect.objectContaining({ body: "Send Alex the PR link", seenAt: null }),
    ]);
  });

  it("clears work streams, messages and questions, but not while a pass may run", async () => {
    await createStream(db, { title: "Ship billing" });
    await createStream(db, { title: "Chase review", status: "waiting-on-others" });
    await createStream(db, { title: "Old fix", status: "done" });
    await post("/messages", { body: "watch #billing-intake" });
    await askUser(db, { kind: "question", question: "Which repo?" });

    await post("/start", {});
    expect((await post("/clear")).status).toBe(409);
    expect(await get("/messages")).toHaveLength(1);

    await post("/pause");
    const res = await post("/clear");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ droppedStreams: 2, deletedMessages: 1 });

    const streams = await sql`SELECT id, status FROM work_streams ORDER BY title`;
    expect(streams.map((r) => r.status)).toEqual(["dropped", "done", "dropped"]);
    expect(await get("/messages")).toEqual([]);
    expect(await get("/questions")).toEqual([]);
    // The paused run itself is left alone.
    expect(await get("")).toMatchObject({ run: { status: "active" } });
  });

  it("answers a question once, and clears it from the attention bell", async () => {
    const question = await askUser(db, {
      kind: "question",
      question: "Where should I ask for review?",
      options: ["#billing-reviews"],
    });

    expect(
      (await post(`/questions/${question.id}/answer`, { choice: "#billing-reviews" })).status,
    ).toBe(200);
    expect(
      (await post(`/questions/${question.id}/answer`, { choice: "#billing-reviews" })).status,
    ).toBe(409);
    expect(await get("/questions")).toEqual([]);
    const items = await sql`SELECT status, nav_target FROM attention_items`;
    expect([...items]).toEqual([
      expect.objectContaining({ status: "resolved", nav_target: { type: "heads-down" } }),
    ]);
  });

  it("saves working hours, and refuses a min sleep above the max", async () => {
    const valid = {
      minSleepMinutes: 5,
      maxSleepMinutes: 120,
      idleSleepMinutes: 60,
      workingHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      userAwayAfterMinutes: 120,
      provider: null,
      model: null,
    };
    const put = (body: unknown) =>
      app.request("/api/heads-down/config", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });

    expect((await put({ ...valid, workingHours: null })).status).toBe(200);
    expect(await get("/config")).toMatchObject({ workingHours: null });
    expect((await put({ ...valid, minSleepMinutes: 200 })).status).toBe(400);
    expect(
      (await put({ ...valid, workingHours: { ...valid.workingHours, start: "9am" } })).status,
    ).toBe(400);
  });

  it("saves the standing guidance, and treats a blank one as none", async () => {
    const valid = {
      minSleepMinutes: 5,
      maxSleepMinutes: 120,
      idleSleepMinutes: 60,
      workingHours: null,
      userAwayAfterMinutes: 120,
      provider: null,
      model: null,
    };
    const put = (body: unknown) =>
      app.request("/api/heads-down/config", {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });

    expect((await put({ ...valid, guidance: "  Merging is fine on my repos.  " })).status).toBe(
      200,
    );
    expect(await get("/config")).toMatchObject({ guidance: "Merging is fine on my repos." });
    expect((await put({ ...valid, guidance: "   " })).status).toBe(200);
    expect(await get("/config")).toMatchObject({ guidance: null });
    expect((await put({ ...valid, guidance: "x".repeat(4001) })).status).toBe(400);
    expect((await put({ ...valid, guidance: null })).status).toBe(200);
    // A client that doesn't send it can still save.
    expect((await put(valid)).status).toBe(200);
  });

  it("allows an MCP tool for heads-down mode, and refuses a tool that isn't one", async () => {
    await sql`TRUNCATE agent_tools`;
    await sql`INSERT INTO agent_tools (id, source, name, content_hash)
              VALUES ('mcp:slack:post_message', 'mcp', 'post_message', 'h'),
                     ('builtin:archive_workspace', 'builtin', 'archive_workspace', 'h')`;
    const put = (id: string, allowed: boolean) =>
      app.request(`/api/heads-down/allowed-tools/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({ allowed }),
      });

    expect((await put("mcp:slack:post_message", true)).status).toBe(200);
    expect(await get("/allowed-tools")).toEqual([
      { id: "mcp:slack:post_message", name: "post_message" },
    ]);
    // A built-in's go-ahead comes from the pass policy, never from this list.
    expect((await put("builtin:archive_workspace", true)).status).toBe(404);
  });

  it("answers 404 for a pass that doesn't exist", async () => {
    const res = await app.request("/api/heads-down/passes/00000000-0000-4000-8000-000000000000", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("lists each pass with how many calls it made and which failed", async () => {
    const run = await startRun(db, null);
    const session = await createSession(db, "Heads down", { hidden: true });
    const pass = await startPass(db, run.id, session.id);
    await addChatMessage(db, {
      sessionId: session.id,
      role: "assistant",
      content: "(Failed here: overloaded)",
      toolCalls: [
        { id: "1", name: "list_work_streams", status: "ok", result: "[]" },
        {
          id: "2",
          name: "post_message",
          server: "Slack",
          status: "error",
          result: "channel_not_found",
        },
        {
          id: "3",
          name: "send_workspace_instruction",
          status: "error",
          result: CUT_SHORT_RESULT,
        },
      ],
    });
    // A retry in the same pass is a second assistant row; both count.
    await addChatMessage(db, {
      sessionId: session.id,
      role: "assistant",
      content: "(Failed here: overloaded)",
      toolCalls: [{ id: "4", name: "get_workspace_status", status: "pending" }],
    });

    const [listed] = (await get("/passes")) as unknown[];

    expect(listed).toMatchObject({
      id: pass.id,
      callCount: 4,
      failedCalls: [
        { name: "post_message", server: "Slack", error: "channel_not_found", noResult: false },
        expect.objectContaining({ name: "send_workspace_instruction", noResult: true }),
        expect.objectContaining({ name: "get_workspace_status", noResult: true }),
      ],
    });
  });
});
