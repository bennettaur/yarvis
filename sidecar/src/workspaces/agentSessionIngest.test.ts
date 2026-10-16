import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { listLiveAgentSessions, PROCESS_GONE } from "./agentSessions.ts";

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

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-2222-2222-222222222222";
const AGENT_TAB = `ws-claude:${WORKSPACE}`;

async function seedWorkspace(id: string, name: string) {
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${id}, ${name}, ${name}, 'active', '/tmp/ws')`;
}

/** Posts what the registration hook would, for a Claude process `pid`. */
function hook(
  body: Record<string, unknown>,
  {
    workspaceId = WORKSPACE,
    pid = process.pid,
    sessionKey = AGENT_TAB,
    token = "test-attention-token",
  }: { workspaceId?: string; pid?: number; sessionKey?: string; token?: string } = {},
) {
  return app.request(`/ingest/agent-session?workspaceId=${workspaceId}&pid=${pid}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Yarvis-Session-Key": sessionKey,
    },
    body: JSON.stringify(body),
  });
}

const start = (sessionId: string, source = "startup") => ({
  hook_event_name: "SessionStart",
  session_id: sessionId,
  source,
  transcript_path: "/Users/me/.claude/projects/x/y.jsonl",
});

beforeEach(async () => {
  await sql`TRUNCATE workspaces RESTART IDENTITY CASCADE`;
  await seedWorkspace(WORKSPACE, "ws");
  await seedWorkspace(OTHER_WORKSPACE, "other");
});

afterAll(async () => {
  await sql.end();
});

describe("POST /ingest/agent-session", () => {
  it("registers a started session with its pid", async () => {
    const res = await hook(start("s1"));
    expect(res.status).toBe(204);

    const sessions = await listLiveAgentSessions(db, WORKSPACE);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionKey: AGENT_TAB,
      claudeSessionId: "s1",
      pid: process.pid,
      source: "startup",
      primary: true,
    });
  });

  it("reopens the same session on resume, under the new pid", async () => {
    await hook(start("s1"), { pid: process.ppid });
    await hook({ hook_event_name: "SessionEnd", session_id: "s1", reason: "logout" });
    await hook(start("s1", "resume"), { pid: process.pid });

    const sessions = await listLiveAgentSessions(db, WORKSPACE);
    expect(sessions.map((s) => [s.claudeSessionId, s.pid, s.source])).toEqual([
      ["s1", process.pid, "resume"],
    ]);
  });

  it("drops an ended session from the live list", async () => {
    await hook(start("s1"));
    await hook({ hook_event_name: "SessionEnd", session_id: "s1", reason: "exit" });

    expect(await listLiveAgentSessions(db, WORKSPACE)).toEqual([]);
    const [row] = await sql`SELECT end_reason FROM workspace_agent_sessions`;
    expect(row!.end_reason).toBe("exit");
  });

  it("marks the earliest live session as primary", async () => {
    await hook(start("first"));
    await hook(start("pane"), { sessionKey: `ws:${WORKSPACE}/t1/p1` });

    const sessions = await listLiveAgentSessions(db, WORKSPACE);
    expect(sessions.map((s) => [s.claudeSessionId, s.primary])).toEqual([
      ["first", true],
      ["pane", false],
    ]);
  });

  it("refuses a session key from another workspace", async () => {
    const res = await hook(start("s1"), { sessionKey: `ws-claude:${OTHER_WORKSPACE}` });
    expect(res.status).toBe(400);
    expect(await listLiveAgentSessions(db, OTHER_WORKSPACE)).toEqual([]);
  });

  it("answers 404 for a workspace that doesn't exist", async () => {
    const missing = "33333333-3333-3333-3333-333333333333";
    const res = await hook(start("s1"), {
      workspaceId: missing,
      sessionKey: `ws-claude:${missing}`,
    });
    expect(res.status).toBe(404);
  });

  it("refuses the full-access bearer and an unknown event", async () => {
    expect((await hook(start("s1"), { token: "test-token" })).status).toBe(401);
    expect((await hook({ hook_event_name: "Stop", session_id: "s1" })).status).toBe(400);
  });
});

describe("listLiveAgentSessions", () => {
  it("closes a session whose process has gone without a SessionEnd", async () => {
    await hook(start("crashed"), { pid: 999_999 });
    await hook(start("alive"));

    const sessions = await listLiveAgentSessions(db, WORKSPACE, (pid) => pid !== 999_999);
    expect(sessions.map((s) => [s.claudeSessionId, s.primary])).toEqual([["alive", true]]);
    const [row] =
      await sql`SELECT end_reason FROM workspace_agent_sessions WHERE claude_session_id = 'crashed'`;
    expect(row!.end_reason).toBe(PROCESS_GONE);
  });
});
