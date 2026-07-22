import { describe, expect, it } from "bun:test";
import type { AttentionItem } from "./attention";
import { applyAttentionItem } from "./attentionStore";

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
