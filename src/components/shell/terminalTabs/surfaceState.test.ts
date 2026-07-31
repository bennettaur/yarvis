import { beforeEach, describe, expect, it } from "bun:test";
import {
  defaultState,
  loadState,
  pinnedTabId,
  type SurfaceState,
  stateAfterCloseTab,
  storageKeyFor,
} from "./surfaceState";

/** A surface holding `count` terminal tabs, with the first one active. */
function withTabs(count: number): SurfaceState {
  const tabs = Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    title: `Terminal ${i}`,
    kind: "terminal" as const,
    root: { kind: "leaf" as const, id: `p${i}` },
  }));
  return {
    tabs,
    activeTabId: tabs[0]?.id ?? "",
    focused: Object.fromEntries(tabs.map((t, i) => [t.id, `p${i}`])),
  };
}

describe("defaultState", () => {
  it('opens a shell tab for "terminal"', () => {
    const state = defaultState("terminal");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.id ?? "");
  });

  it('opens nothing for "none"', () => {
    // A workspace's agent tab is supplied by its owner, so spawning a shell here
    // would be the extra tab the user has to close.
    expect(defaultState("none").tabs).toHaveLength(0);
  });
});

describe("loadState", () => {
  beforeEach(() => localStorage.clear());

  it('starts empty with nothing persisted, for "none"', () => {
    expect(loadState("ws:ws1", "none").tabs).toHaveLength(0);
  });

  it('starts with a shell with nothing persisted, for "terminal"', () => {
    expect(loadState("tab:terminal", "terminal").tabs).toHaveLength(1);
  });

  it("keeps tabs the user already had", () => {
    localStorage.setItem(storageKeyFor("ws:ws1"), JSON.stringify(withTabs(2)));
    expect(loadState("ws:ws1", "none").tabs).toHaveLength(2);
  });

  it('honours a persisted empty surface rather than reopening a shell, for "none"', () => {
    localStorage.setItem(storageKeyFor("ws:ws1"), JSON.stringify(withTabs(0)));
    expect(loadState("ws:ws1", "none").tabs).toHaveLength(0);
  });

  it("falls back to the default on malformed storage", () => {
    localStorage.setItem(storageKeyFor("ws:ws1"), "not json");
    expect(loadState("ws:ws1", "none").tabs).toHaveLength(0);
    expect(loadState("tab:terminal", "terminal").tabs).toHaveLength(1);
  });
});

describe("stateAfterCloseTab", () => {
  it("drops the tab and its focus entry", () => {
    const next = stateAfterCloseTab(withTabs(2), "t1", "none", null);
    expect(next.tabs.map((t) => t.id)).toEqual(["t0"]);
    expect(next.focused.t1).toBeUndefined();
  });

  it("moves the selection off a closed active tab", () => {
    const next = stateAfterCloseTab(withTabs(2), "t0", "none", null);
    expect(next.activeTabId).toBe("t1");
  });

  it("leaves the selection alone when a background tab closes", () => {
    const next = stateAfterCloseTab(withTabs(2), "t1", "none", null);
    expect(next.activeTabId).toBe("t0");
  });

  it('reopens a shell when the last tab closes, for "terminal"', () => {
    const next = stateAfterCloseTab(withTabs(1), "t0", "terminal", null);
    expect(next.tabs).toHaveLength(1);
  });

  it('leaves the surface empty when the last tab closes, for "none"', () => {
    // The bug this guards: respawning here made the extra terminal tab
    // unclosable — closing it just produced another one.
    const next = stateAfterCloseTab(withTabs(1), "t0", "none", "agent");
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBe(pinnedTabId("agent"));
  });

  it("leaves nothing selected when the last tab closes with no pinned tab", () => {
    const next = stateAfterCloseTab(withTabs(1), "t0", "none", null);
    expect(next.tabs).toHaveLength(0);
    expect(next.activeTabId).toBe("");
  });
});
