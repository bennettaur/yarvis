import { describe, expect, it } from "bun:test";
import type { AttentionItemRow } from "../db/schema.ts";
import { publish, subscribe, subscriberCount } from "./hub.ts";

function row(id: string): AttentionItemRow {
  return {
    id,
    seq: 1,
    source: "claude-hook",
    sessionKey: "ws-claude:w1",
    workspaceId: "w1",
    kind: "permission",
    title: "Fix API",
    body: null,
    status: "pending",
    navTarget: null,
    payload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    readAt: null,
    resolvedAt: null,
  };
}

describe("attention hub", () => {
  it("delivers published items to subscribers and stops after unsubscribe", () => {
    const seen: string[] = [];
    const unsubscribe = subscribe((item) => seen.push(item.id));
    publish(row("a"));
    publish(row("b"));
    unsubscribe();
    publish(row("c"));
    expect(seen).toEqual(["a", "b"]);
    expect(subscriberCount()).toBe(0);
  });

  it("fans out to every subscriber and isolates a throwing listener", () => {
    const seen: string[] = [];
    const unsubBad = subscribe(() => {
      throw new Error("boom");
    });
    const unsubGood = subscribe((item) => seen.push(item.id));
    // A throwing listener must not prevent the others from receiving the item.
    expect(() => publish(row("x"))).not.toThrow();
    expect(seen).toEqual(["x"]);
    unsubBad();
    unsubGood();
  });
});
