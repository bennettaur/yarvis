import { describe, expect, it } from "bun:test";
import type { AttentionItem } from "./attention";
import { groupAttentionItems, nextAnswerable } from "./attentionGroups";

function item(overrides: Partial<AttentionItem> & { id: string; seq: number }): AttentionItem {
  return {
    source: "claude-hook",
    sessionKey: "ws-claude:w1",
    workspaceId: "w1",
    kind: "permission",
    title: "Fix API",
    body: "Needs permission",
    status: "pending",
    navTarget: { type: "workspace-claude", workspaceId: "w1" },
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

describe("groupAttentionItems", () => {
  it("collapses repeat asks from one workspace into a single entry", () => {
    const groups = groupAttentionItems([
      item({ id: "b", seq: 2, kind: "idle", sessionKey: "ws:w1/t2/p1" }),
      item({ id: "a", seq: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["b", "a"]);
    expect(groups[0]!.scope).toEqual({ workspaceId: "w1" });
  });

  it("keeps separate workspaces apart, newest group first", () => {
    const groups = groupAttentionItems([
      item({ id: "b", seq: 2, workspaceId: "w2", sessionKey: "ws-claude:w2" }),
      item({ id: "a", seq: 1 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["workspace:w2", "workspace:w1"]);
  });

  it("leads with the most urgent item, not merely the newest", () => {
    const groups = groupAttentionItems([
      item({ id: "b", seq: 5, kind: "completed", sessionKey: "ws:w1/t2/p1" }),
      item({ id: "a", seq: 1, kind: "permission" }),
    ]);
    expect(groups[0]!.lead.id).toBe("a");
  });

  it("lists every session behind a group so a row can name the tabs", () => {
    const groups = groupAttentionItems([
      item({ id: "b", seq: 2, sessionKey: "ws:w1/t2/p1" }),
      item({ id: "a", seq: 1, sessionKey: "ws-claude:w1" }),
    ]);
    expect(groups[0]!.sessionKeys).toEqual(["ws:w1/t2/p1", "ws-claude:w1"]);
  });

  it("groups a workspaceless session by its session, scoped the same way", () => {
    const groups = groupAttentionItems([
      item({ id: "a", seq: 1, workspaceId: null, sessionKey: "tab:terminal/t1/p1" }),
      item({ id: "b", seq: 2, workspaceId: null, sessionKey: "tab:terminal/t1/p1" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toEqual({ sessionKey: "tab:terminal/t1/p1" });
  });

  it("never merges sourceless nudges with each other", () => {
    const groups = groupAttentionItems([
      item({ id: "a", seq: 1, workspaceId: null, sessionKey: null, source: "chat-agent" }),
      item({ id: "b", seq: 2, workspaceId: null, sessionKey: null, source: "chat-agent" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.scope).toEqual({});
  });
});

describe("nextAnswerable", () => {
  const done = item({ id: "done", seq: 5, sessionKey: "ws:w1/t1/p1" });

  it("picks the oldest other prompt from the same workspace", () => {
    const next = nextAnswerable(
      [
        item({ id: "newer", seq: 9, sessionKey: "ws:w1/t3/p1" }),
        item({
          id: "older",
          seq: 2,
          kind: "question",
          source: "system",
          sessionKey: "ws:w1/t2/p1",
        }),
        done,
      ],
      done,
    );
    expect(next?.id).toBe("older");
  });

  it("skips the finished session, other workspaces, and items without a dialog", () => {
    const next = nextAnswerable(
      [
        item({ id: "same-session", seq: 6, kind: "idle", sessionKey: "ws:w1/t1/p1" }),
        item({ id: "other-ws", seq: 7, workspaceId: "w2", sessionKey: "ws:w2/t1/p1" }),
        item({ id: "idle", seq: 8, kind: "idle", sessionKey: "ws:w1/t4/p1" }),
        done,
      ],
      done,
    );
    expect(next).toBeNull();
  });

  it("never chains into a heads-down item that names a workspace", () => {
    const posing = item({
      id: "hd",
      seq: 1,
      source: "system",
      kind: "info",
      sessionKey: "heads-down:q1",
    });
    expect(nextAnswerable([posing, done], done)).toBeNull();
  });

  it("skips the finished session's own prompt while it is still on the stream", () => {
    const same = item({ id: "same", seq: 1, sessionKey: "ws:w1/t1/p1" });
    expect(nextAnswerable([same, done], done)).toBeNull();
  });

  it("skips a question whose session runs outside the workspace it names", () => {
    // An ask_user caller chooses both its session key and its workspace id.
    const posing = item({
      id: "posing",
      seq: 1,
      kind: "question",
      source: "system",
      sessionKey: "ws:w2/t1/p1",
    });
    expect(nextAnswerable([posing, done], done)).toBeNull();
  });

  it("follows nothing from a prompt outside a workspace", () => {
    const loose = item({ id: "loose", seq: 1, workspaceId: null, sessionKey: "term/t1/p1" });
    const question = item({
      id: "q",
      seq: 2,
      workspaceId: null,
      kind: "question",
      source: "system",
      sessionKey: "term/t2/p1",
    });
    expect(nextAnswerable([question, loose], loose)).toBeNull();
  });

  it("follows nothing outside a workspace", () => {
    const loose = item({
      id: "hd",
      seq: 1,
      workspaceId: null,
      source: "system",
      sessionKey: "heads-down:q1",
    });
    const other = item({
      id: "hd2",
      seq: 2,
      workspaceId: null,
      source: "system",
      sessionKey: "heads-down:q2",
    });
    expect(nextAnswerable([other, loose], loose)).toBeNull();
  });
});
