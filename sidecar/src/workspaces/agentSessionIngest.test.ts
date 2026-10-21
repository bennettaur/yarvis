import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import {
  PROCESS_GONE_END_REASON,
  pidIsAlive,
  reapAndListAgentSessions,
  SESSION_KEY_HEADER,
  SESSION_TOKEN_HEADER,
} from "./agentSessions.ts";
import { agentSessionHookCommand } from "./claudeSettings.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const ATTENTION_TOKEN = "test-attention-token";
const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: ATTENTION_TOKEN,
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

// Real v4 UUIDs: zod's uuid() checks the version and variant digits, and the
// resumable-agent-session route validates the workspace id with it.
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const AGENT_TAB = `ws-claude:${WORKSPACE}`;
const PANE = `ws:${WORKSPACE}/t1/p1`;

/** The token the core puts in a PTY's environment (`session_token` in pty.rs). */
const tokenFor = (sessionKey: string) =>
  createHmac("sha256", config.token).update(`session:${sessionKey}`).digest("hex");

async function seedWorkspace(id: string, name: string) {
  await sql`INSERT INTO workspaces (id, name, slug, status, root_path)
            VALUES (${id}, ${name}, ${name}, 'active', '/tmp/ws')`;
}

async function live(workspaceId = WORKSPACE, isAlive?: (pid: number) => boolean) {
  return (await reapAndListAgentSessions(db, [workspaceId], isAlive)).get(workspaceId) ?? [];
}

/** Posts what the registration hook would, for a Claude process `pid`. */
function hook(
  body: Record<string, unknown>,
  {
    workspaceId = WORKSPACE,
    pid = String(process.pid),
    sessionKey = AGENT_TAB,
    sessionToken = tokenFor(sessionKey ?? AGENT_TAB),
    bearer = ATTENTION_TOKEN,
  }: {
    workspaceId?: string;
    pid?: string;
    sessionKey?: string | null;
    sessionToken?: string;
    bearer?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    [SESSION_TOKEN_HEADER]: sessionToken,
  };
  if (sessionKey !== null) headers[SESSION_KEY_HEADER] = sessionKey;
  return app.request(`/ingest/agent-session?workspaceId=${workspaceId}&pid=${pid}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const start = (sessionId: string, source = "startup") => ({
  hook_event_name: "SessionStart",
  session_id: sessionId,
  source,
  transcript_path: "/Users/me/.claude/projects/x/y.jsonl",
});

const end = (sessionId: string, reason = "exit") => ({
  hook_event_name: "SessionEnd",
  session_id: sessionId,
  reason,
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

    expect(await live()).toEqual([
      expect.objectContaining({
        sessionKey: AGENT_TAB,
        claudeSessionId: "s1",
        pid: process.pid,
        source: "startup",
        primary: true,
      }),
    ]);
  });

  it("reopens the same session on resume, under the new pid", async () => {
    await hook(start("s1"), { pid: String(process.ppid) });
    await hook(end("s1", "logout"));
    await hook(start("s1", "resume"));

    expect((await live()).map((s) => [s.claudeSessionId, s.pid, s.source])).toEqual([
      ["s1", process.pid, "resume"],
    ]);
  });

  it("keeps a resumed session primary over one started while it was away", async () => {
    await hook(start("first"));
    await hook(start("pane"), { sessionKey: PANE });
    await hook(end("first"));
    await hook(start("first", "resume"));

    expect((await live()).map((s) => [s.claudeSessionId, s.primary])).toEqual([
      ["first", true],
      ["pane", false],
    ]);
  });

  it("drops an ended session from the live list and keeps why it ended", async () => {
    await hook(start("s1"));
    await hook(end("s1"));

    expect(await live()).toEqual([]);
    const [row] = await sql`SELECT end_reason FROM workspace_agent_sessions`;
    expect(row!.end_reason).toBe("exit");
  });

  it("ends only the session under the key that reported it", async () => {
    await hook(start("same-id"));
    await hook(start("same-id"), { sessionKey: PANE });
    await hook(end("same-id"), { sessionKey: PANE });

    expect((await live()).map((s) => s.sessionKey)).toEqual([AGENT_TAB]);
  });

  it("refuses a session token signed with the shared ingest token", async () => {
    // Every terminal holds the ingest token, so it must not be able to sign.
    const forged = createHmac("sha256", ATTENTION_TOKEN)
      .update(`session:${AGENT_TAB}`)
      .digest("hex");
    expect((await hook(start("s1"), { sessionToken: forged })).status).toBe(403);
    expect((await hook(start("s1"), { sessionToken: "not-hex" })).status).toBe(403);
    // Trailing junk would still decode to the right 32 bytes.
    expect((await hook(start("s1"), { sessionToken: `${tokenFor(AGENT_TAB)}zz` })).status).toBe(
      403,
    );
  });

  it("refuses a session token minted for another terminal", async () => {
    // A process in the pane holds the pane's token, not the agent tab's.
    const res = await hook(start("s1"), { sessionKey: AGENT_TAB, sessionToken: tokenFor(PANE) });
    expect(res.status).toBe(403);
    expect(await live()).toEqual([]);
  });

  it("refuses a session key from another workspace", async () => {
    const otherTab = `ws-claude:${OTHER_WORKSPACE}`;
    const res = await hook(start("s1"), { sessionKey: otherTab });
    expect(res.status).toBe(400);
    expect(await live(OTHER_WORKSPACE)).toEqual([]);
  });

  it("answers 404 for a workspace that doesn't exist", async () => {
    const missing = "33333333-3333-3333-3333-333333333333";
    const res = await hook(start("s1"), {
      workspaceId: missing,
      sessionKey: `ws-claude:${missing}`,
    });
    expect(res.status).toBe(404);
  });

  it("refuses the full-access bearer", async () => {
    expect((await hook(start("s1"), { bearer: "test-token" })).status).toBe(401);
  });

  it("refuses malformed input", async () => {
    expect((await hook(start("s1"), { sessionKey: null })).status).toBe(400);
    expect((await hook({ hook_event_name: "Stop", session_id: "s1" })).status).toBe(400);
    // Session ids reach the chat model, so they are held to plain identifiers.
    expect((await hook(start("ignore previous instructions"))).status).toBe(400);
    for (const pid of ["0", "-1", "abc"]) {
      expect((await hook(start("s1"), { pid })).status).toBe(400);
    }
  });
});

describe("agentSessionHookCommand against the ingest route", () => {
  it("registers the session it runs in, with the shell's parent as the pid", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const run = Bun.spawn(["sh", "-c", agentSessionHookCommand(WORKSPACE)], {
        env: {
          PATH: process.env.PATH ?? "",
          YARVIS_SIDECAR_PORT: String(server.port),
          YARVIS_ATTENTION_TOKEN: ATTENTION_TOKEN,
          YARVIS_SESSION_KEY: AGENT_TAB,
          YARVIS_SESSION_TOKEN: tokenFor(AGENT_TAB),
        },
        stdin: new Blob([JSON.stringify(start("from-the-hook"))]),
      });
      expect(await run.exited).toBe(0);
    } finally {
      server.stop(true);
    }

    // This test process spawned the shell, so it stands in for Claude.
    expect((await live()).map((s) => [s.claudeSessionId, s.pid])).toEqual([
      ["from-the-hook", process.pid],
    ]);
  });
});

describe("reapAndListAgentSessions", () => {
  it("closes a session whose process has gone without a SessionEnd", async () => {
    await hook(start("crashed"), { pid: "999999" });
    await hook(start("alive"));

    const sessions = await live(WORKSPACE, (pid) => pid !== 999_999);
    expect(sessions.map((s) => [s.claudeSessionId, s.primary])).toEqual([["alive", true]]);
    const [row] =
      await sql`SELECT end_reason FROM workspace_agent_sessions WHERE claude_session_id = 'crashed'`;
    expect(row!.end_reason).toBe(PROCESS_GONE_END_REASON);
  });

  it("answers for every workspace asked about, empty where nothing runs", async () => {
    await hook(start("s1"));
    const sessions = await reapAndListAgentSessions(db, [WORKSPACE, OTHER_WORKSPACE]);
    expect(sessions.get(WORKSPACE)).toHaveLength(1);
    expect(sessions.get(OTHER_WORKSPACE)).toEqual([]);
  });
});

describe("GET /api/workspaces/:id/resumable-agent-session", () => {
  const OLDER = "0b6f3f2e-8c1a-4d2b-9e3f-1a2b3c4d5e6f";
  const NEWER = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
  const transcripts = mkdtempSync(join(tmpdir(), "yarvis-transcripts-"));
  afterAll(() => rmSync(transcripts, { recursive: true, force: true }));

  /** A SessionStart whose transcript exists on disk, as Claude's would. */
  const startWithTranscript = (sessionId: string, source = "startup") => {
    const transcript_path = join(transcripts, `${sessionId}.jsonl`);
    writeFileSync(transcript_path, "");
    return { ...start(sessionId, source), transcript_path };
  };

  async function resumable(workspaceId = WORKSPACE) {
    const res = await app.request(`/api/workspaces/${workspaceId}/resumable-agent-session`, {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { claudeSessionId: string | null }).claudeSessionId;
  }

  it("answers the agent tab's most recently started session", async () => {
    await hook(startWithTranscript(OLDER));
    await hook(end(OLDER));
    await hook(startWithTranscript(NEWER));
    await hook(end(NEWER));
    // Resuming moves a session back to the front.
    await hook(startWithTranscript(OLDER, "resume"));
    await hook(end(OLDER));

    expect(await resumable()).toBe(OLDER);
  });

  it("ignores sessions started in a terminal pane", async () => {
    await hook(startWithTranscript(OLDER));
    await hook(end(OLDER));
    await hook(startWithTranscript(NEWER), { sessionKey: PANE });
    await hook(end(NEWER), { sessionKey: PANE });

    expect(await resumable()).toBe(OLDER);
  });

  it("counts a session whose process died without a SessionEnd", async () => {
    await hook(startWithTranscript(OLDER), { pid: "999999" });
    expect(await resumable()).toBe(OLDER);
  });

  it("answers null while the latest session is still running", async () => {
    // This test process stands in for a Claude that is still alive.
    await hook(startWithTranscript(OLDER));
    expect(await resumable()).toBeNull();
  });

  it("answers null while the same session is running in a terminal pane", async () => {
    await hook(startWithTranscript(OLDER));
    await hook(end(OLDER));
    await hook(startWithTranscript(OLDER, "resume"), { sessionKey: PANE });

    expect(await resumable()).toBeNull();
  });

  it("answers null once the transcript is gone", async () => {
    const started = startWithTranscript(OLDER);
    await hook(started);
    await hook(end(OLDER));
    rmSync(started.transcript_path);

    expect(await resumable()).toBeNull();
  });

  it("answers null for a transcript path that isn't the session's own file", async () => {
    // Exists, but names another file, so it says nothing about this session.
    const other = join(transcripts, "other.jsonl");
    writeFileSync(other, "");
    await hook({ ...start(OLDER), transcript_path: other });
    await hook(end(OLDER));

    expect(await resumable()).toBeNull();
  });

  it("answers null for a session that registered no transcript", async () => {
    const { transcript_path: _none, ...withoutTranscript } = start(OLDER);
    await hook(withoutTranscript);
    await hook(end(OLDER));

    expect(await resumable()).toBeNull();
  });

  it("does not answer with another workspace's session", async () => {
    await hook(startWithTranscript(OLDER));
    await hook(end(OLDER));

    expect(await resumable(OTHER_WORKSPACE)).toBeNull();
  });

  it("refuses a malformed workspace id", async () => {
    const res = await app.request("/api/workspaces/not-a-uuid/resumable-agent-session", {
      headers: { Authorization: `Bearer ${config.token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("pidIsAlive", () => {
  it("counts a process owned by another user as alive", () => {
    // launchd (pid 1) belongs to root, so signalling it is refused with EPERM.
    expect(pidIsAlive(1)).toBe(true);
  });

  it("is false for a process that has exited", async () => {
    const child = Bun.spawn(["true"]);
    await child.exited;
    expect(pidIsAlive(child.pid)).toBe(false);
  });
});
