import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createAttention } from "../attention/service.ts";
import { ccProjectDirFor } from "../cc/sessions.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  AGENT_PERMISSION_REASON,
  AGENT_WORKING_REASON,
  agentBusyReason,
  TRANSCRIPT_SETTLE_MS,
  workspaceAgentBusyReason,
} from "./agentBusy.ts";
import { createWorkspace } from "./service.ts";

const sessionKey = "ws-claude:w1";
const at = (ms: number) => new Date(ms);

type Item = Parameters<typeof agentBusyReason>[0]["items"][number];

const item = (overrides: Partial<Item>): Item => ({
  sessionKey,
  source: "claude-hook",
  kind: "completed",
  status: "pending",
  createdAt: at(1_000_000),
  updatedAt: at(1_000_000),
  ...overrides,
});

describe("agentBusyReason", () => {
  it("is idle when the session has never written a transcript", () => {
    expect(agentBusyReason({ sessionKey, items: [], transcriptMtimeMs: null })).toBeNull();
  });

  it("is working when it has written a transcript but never signalled waiting", () => {
    expect(agentBusyReason({ sessionKey, items: [], transcriptMtimeMs: 1_000_000 })).toBe(
      AGENT_WORKING_REASON,
    );
  });

  it("is idle when the last turn ended after the transcript was written", () => {
    expect(
      agentBusyReason({ sessionKey, items: [item({})], transcriptMtimeMs: 1_000_000 - 5_000 }),
    ).toBeNull();
  });

  // Claude Code appends a few lines once the turn is over.
  it("ignores transcript writes just after the turn ended", () => {
    expect(
      agentBusyReason({
        sessionKey,
        items: [item({ kind: "idle" })],
        transcriptMtimeMs: 1_000_000 + TRANSCRIPT_SETTLE_MS,
      }),
    ).toBeNull();
  });

  it("is working when the transcript moved on after the last turn ended", () => {
    expect(
      agentBusyReason({
        sessionKey,
        items: [item({})],
        transcriptMtimeMs: 1_000_000 + TRANSCRIPT_SETTLE_MS + 1,
      }),
    ).toBe(AGENT_WORKING_REASON);
  });

  // Viewing the workspace marks items read, which bumps `updatedAt` to when the
  // user looked; that must not hide a turn that started before they looked.
  it("dates a read item by when it was raised, not when it was read", () => {
    expect(
      agentBusyReason({
        sessionKey,
        items: [item({ status: "resolved", updatedAt: at(9_000_000) })],
        transcriptMtimeMs: 2_000_000,
      }),
    ).toBe(AGENT_WORKING_REASON);
  });

  it("is blocked when a permission prompt is pending", () => {
    expect(
      agentBusyReason({
        sessionKey,
        items: [item({}), item({ kind: "permission" })],
        transcriptMtimeMs: 1_000_000,
      }),
    ).toBe(AGENT_PERMISSION_REASON);
  });

  it("only counts the agent tab's own hook items", () => {
    expect(
      agentBusyReason({
        sessionKey,
        items: [
          item({ sessionKey: "ws:w1/tab/pane" }),
          item({ source: "chat-agent" }),
          item({ sessionKey: "ws:w1/tab/pane", kind: "permission" }),
        ],
        transcriptMtimeMs: 900_000,
      }),
    ).toBe(AGENT_WORKING_REASON);
  });
});

describe("workspaceAgentBusyReason", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const db = getDb(url).db;
  const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-busy-root-"));
  const config = { databaseUrl: url, workspacesRoot } as Config;
  const previousHome = process.env.CLAUDE_HOME;
  let claudeHome: string;

  /** Writes the agent tab's transcript, last modified `at`. */
  const writeTranscript = (rootPath: string, at: Date) => {
    const dir = join(claudeHome, "projects", ccProjectDirFor(rootPath));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "s-1.jsonl");
    writeFileSync(file, "{}\n");
    utimesSync(file, at, at);
  };

  const hookItem = (workspaceId: string, kind: "completed" | "permission") =>
    createAttention(db, {
      source: "claude-hook",
      sessionKey: `ws-claude:${workspaceId}`,
      workspaceId,
      kind,
      title: kind,
    });

  beforeEach(async () => {
    await sql`TRUNCATE workspaces, attention_items RESTART IDENTITY CASCADE`;
    claudeHome = mkdtempSync(join(tmpdir(), "yarvis-busy-claude-"));
    process.env.CLAUDE_HOME = claudeHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CLAUDE_HOME;
    else process.env.CLAUDE_HOME = previousHome;
    rmSync(claudeHome, { recursive: true, force: true });
  });

  afterAll(async () => {
    await sql.end();
    rmSync(workspacesRoot, { recursive: true, force: true });
  });

  it("reads the workspace's hook items and its root's transcript", async () => {
    const ws = await createWorkspace(db, config, { name: "Busy", repoIds: [] });
    expect(await workspaceAgentBusyReason(db, ws)).toBeNull();

    writeTranscript(ws.rootPath, new Date());
    expect(await workspaceAgentBusyReason(db, ws)).toBe(AGENT_WORKING_REASON);

    // The turn ended after the transcript was last written.
    writeTranscript(ws.rootPath, new Date(Date.now() - 60_000));
    await hookItem(ws.id, "completed");
    expect(await workspaceAgentBusyReason(db, ws)).toBeNull();

    await hookItem(ws.id, "permission");
    expect(await workspaceAgentBusyReason(db, ws)).toBe(AGENT_PERMISSION_REASON);
  });
});
