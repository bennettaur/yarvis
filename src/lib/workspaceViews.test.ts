import { describe, expect, it } from "bun:test";
import type { ViewedScope } from "./attentionScope";
import { claimView, VIEW_THROTTLE_MS, viewedTab } from "./workspaceViews";

function scope(sessionKeys: string[]): ViewedScope {
  return { workspaceId: "w1", sessionKeys: new Set(sessionKeys), focused: true };
}

describe("viewedTab", () => {
  it("names the agent tab by its pinned session", () => {
    expect(viewedTab(scope(["ws-claude:w1"]), "w1")).toBe("agent");
  });

  it("names one of the workspace's own shells", () => {
    expect(viewedTab(scope(["ws:w1/t1/p1", "ws:w1/t1/p2"]), "w1")).toBe("terminal");
  });

  it("calls a tab with no session, or another workspace's session, other", () => {
    expect(viewedTab(scope([]), "w1")).toBe("other");
    expect(viewedTab(scope(["ws:w10/t1/p1", "ws-claude:w2"]), "w1")).toBe("other");
  });
});

describe("claimView", () => {
  it("records once per window for the same workspace and tab", () => {
    const recorded = new Map<string, number>();
    expect(claimView("w1:agent", 0, recorded)).toBe(true);
    expect(claimView("w1:agent", VIEW_THROTTLE_MS - 1, recorded)).toBe(false);
    expect(claimView("w1:terminal", 1, recorded)).toBe(true);
    expect(claimView("w1:agent", VIEW_THROTTLE_MS, recorded)).toBe(true);
  });
});
