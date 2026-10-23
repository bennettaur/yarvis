import { describe, expect, it } from "bun:test";
import {
  AGENT_PERMISSION_REASON,
  AGENT_WORKING_REASON,
  agentBusyReason,
  TRANSCRIPT_SETTLE_MS,
} from "./agentBusy.ts";

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
