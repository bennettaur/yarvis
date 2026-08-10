import { describe, expect, it } from "bun:test";
import type { AttentionItem } from "./attention";
import type { ViewedScope } from "./attentionScope";
import { applyAttentionItem, clearTargetsFor } from "./attentionStore";

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

describe("applyAttentionItem", () => {
  it("adds a new pending item and reports it as added", () => {
    const result = applyAttentionItem([], item({ id: "a", seq: 1 }));
    expect(result.added).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.list.map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps the list newest-first by seq", () => {
    let list: AttentionItem[] = [];
    list = applyAttentionItem(list, item({ id: "a", seq: 1 })).list;
    list = applyAttentionItem(list, item({ id: "b", seq: 3 })).list;
    list = applyAttentionItem(list, item({ id: "c", seq: 2 })).list;
    expect(list.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("upserts an existing item by id without duplicating and is not 'added'", () => {
    const first = applyAttentionItem([], item({ id: "a", seq: 1, title: "old" }));
    const second = applyAttentionItem(first.list, item({ id: "a", seq: 1, title: "new" }));
    expect(second.added).toBe(false);
    expect(second.list).toHaveLength(1);
    expect(second.list[0]!.title).toBe("new");
  });

  it("removes an item when it is no longer pending", () => {
    const first = applyAttentionItem([], item({ id: "a", seq: 1 }));
    const removed = applyAttentionItem(first.list, item({ id: "a", seq: 1, status: "resolved" }));
    expect(removed.list).toHaveLength(0);
    expect(removed.changed).toBe(true);
    expect(removed.added).toBe(false);
  });

  it("reports no change when removing an item that isn't present", () => {
    const result = applyAttentionItem([], item({ id: "x", seq: 9, status: "read" }));
    expect(result.changed).toBe(false);
  });
});

function scope(overrides: Partial<ViewedScope> = {}): ViewedScope {
  return { workspaceId: null, sessionKeys: new Set(), focused: true, ...overrides };
}

describe("clearTargetsFor", () => {
  it("clears a session once, however many of its items are pending", () => {
    const viewing = scope({ sessionKeys: new Set(["ws:w1/t1/p1"]) });
    const items = [
      item({ id: "a", seq: 1, sessionKey: "ws:w1/t1/p1" }),
      item({ id: "b", seq: 2, sessionKey: "ws:w1/t1/p1", kind: "idle" }),
    ];
    expect(clearTargetsFor(items, viewing)).toEqual({
      sessionKeys: ["ws:w1/t1/p1"],
      itemIds: [],
    });
  });

  it("leaves items whose tab is not on screen", () => {
    const viewing = scope({ workspaceId: "w1", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    const items = [item({ id: "a", seq: 1, sessionKey: "ws:w1/t9/p1" })];
    expect(clearTargetsFor(items, viewing)).toEqual({ sessionKeys: [], itemIds: [] });
  });

  it("clears a sessionless item by id, never by its workspace", () => {
    // A workspace scope would take the background tabs' items with it.
    const viewing = scope({ workspaceId: "w1", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    const items = [
      item({ id: "a", seq: 1, sessionKey: null }),
      item({ id: "b", seq: 2, sessionKey: "ws:w1/t9/p1" }),
    ];
    expect(clearTargetsFor(items, viewing)).toEqual({ sessionKeys: [], itemIds: ["a"] });
  });

  it("clears nothing while the window is in the background", () => {
    const viewing = scope({ sessionKeys: new Set(["ws-claude:w1"]), focused: false });
    expect(clearTargetsFor([item({ id: "a", seq: 1 })], viewing)).toEqual({
      sessionKeys: [],
      itemIds: [],
    });
  });

  it("skips a backlog item so a restored view doesn't silently wipe it", () => {
    const viewing = scope({ sessionKeys: new Set(["ws-claude:w1"]) });
    const items = [item({ id: "a", seq: 1 })];
    expect(clearTargetsFor(items, viewing, (id) => id === "a").sessionKeys).toEqual([]);
    expect(clearTargetsFor(items, viewing).sessionKeys).toEqual(["ws-claude:w1"]);
  });

  it("only names targets that cover a seen item, so the pass converges", () => {
    const viewing = scope({ workspaceId: "w1", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    const items = [
      item({ id: "a", seq: 1, sessionKey: "ws:w1/t1/p1" }),
      item({ id: "b", seq: 2, sessionKey: "ws:w1/t9/p1" }),
      item({ id: "c", seq: 3, sessionKey: null }),
    ];
    // The visible tab and the sessionless item, but nothing that would reach the
    // background tab — a target covering an unseen item would re-fire forever.
    expect(clearTargetsFor(items, viewing)).toEqual({
      sessionKeys: ["ws:w1/t1/p1"],
      itemIds: ["c"],
    });
  });
});
