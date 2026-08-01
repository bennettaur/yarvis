import { beforeEach, describe, expect, it } from "bun:test";
import type { AttentionItem } from "./attention";
import {
  getViewedScope,
  isInView,
  setViewedSessions,
  setViewedWorkspace,
  type ViewedScope,
} from "./attentionScope";

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "a",
    seq: 1,
    source: "claude-hook",
    sessionKey: "ws:w1/t1/p1",
    workspaceId: "w1",
    kind: "permission",
    title: "Fix API",
    body: "Needs permission",
    status: "pending",
    navTarget: { type: "terminal", sessionKey: "ws:w1/t1/p1", workspaceId: "w1" },
    createdAt: "2026-07-12T00:00:00Z",
    updatedAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

function scope(overrides: Partial<ViewedScope> = {}): ViewedScope {
  return { workspaceId: null, sessionKeys: new Set(), focused: true, ...overrides };
}

describe("isInView", () => {
  it("matches the exact session on screen", () => {
    const viewing = scope({ workspaceId: "w1", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    expect(isInView(viewing, item())).toBe(true);
  });

  it("matches a session on screen even while another workspace is selected", () => {
    const viewing = scope({ workspaceId: "w2", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    expect(isInView(viewing, item())).toBe(true);
  });

  it("leaves a session-keyed item pending when its own workspace is open but its tab isn't", () => {
    // What makes the tab strip's highlight reachable: being in the workspace is
    // not the same as having seen the tab that wants you.
    expect(isInView(scope({ workspaceId: "w1" }), item())).toBe(false);
  });

  it("falls back to the workspace for an item that names no session", () => {
    const sessionless = item({ sessionKey: null });
    expect(isInView(scope({ workspaceId: "w1" }), sessionless)).toBe(true);
    expect(isInView(scope({ workspaceId: "w2" }), sessionless)).toBe(false);
  });

  it("does not match a sibling tab in the same surface", () => {
    const viewing = scope({ sessionKeys: new Set(["ws:w1/t2/p1"]) });
    expect(isInView(viewing, item())).toBe(false);
  });

  it("treats nothing as in view while the window is in the background", () => {
    const viewing = scope({ sessionKeys: new Set(["ws:w1/t1/p1"]), focused: false });
    expect(isInView(viewing, item())).toBe(false);
  });

  it("never matches an item with no origin", () => {
    const viewing = scope({ workspaceId: "w1", sessionKeys: new Set(["ws:w1/t1/p1"]) });
    expect(isInView(viewing, item({ workspaceId: null, sessionKey: null }))).toBe(false);
  });
});

describe("viewed scope publishing", () => {
  beforeEach(() => {
    setViewedWorkspace(null);
    for (const surface of ["ws:w1", "tab:terminal"]) setViewedSessions(surface, []);
  });

  it("unions the sessions of every mounted surface", () => {
    setViewedSessions("ws:w1", ["ws:w1/t1/p1", "ws:w1/t1/p2"]);
    setViewedSessions("tab:terminal", ["tab:terminal/t1/p1"]);
    expect([...getViewedScope().sessionKeys].sort()).toEqual([
      "tab:terminal/t1/p1",
      "ws:w1/t1/p1",
      "ws:w1/t1/p2",
    ]);
  });

  it("withdraws only the unmounting surface's sessions", () => {
    setViewedSessions("ws:w1", ["ws:w1/t1/p1"]);
    setViewedSessions("tab:terminal", ["tab:terminal/t1/p1"]);
    setViewedSessions("ws:w1", []);
    expect([...getViewedScope().sessionKeys]).toEqual(["tab:terminal/t1/p1"]);
  });

  it("withdraws the workspace when the view goes away", () => {
    setViewedWorkspace("w1");
    expect(getViewedScope().workspaceId).toBe("w1");
    setViewedWorkspace(null);
    expect(getViewedScope().workspaceId).toBeNull();
  });

  it("keeps the same snapshot when a surface republishes identical sessions", () => {
    setViewedSessions("ws:w1", ["ws:w1/t1/p1"]);
    const before = getViewedScope();
    setViewedSessions("ws:w1", ["ws:w1/t1/p1"]);
    // Identity matters: a fresh snapshot each render would re-fire the auto-clear effect.
    expect(getViewedScope()).toBe(before);
  });
});
