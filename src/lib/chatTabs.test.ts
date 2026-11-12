import { afterEach, describe, expect, it } from "bun:test";
import {
  addTab,
  CHAT_TABS_KEY,
  closeTab,
  LEGACY_CHAT_SESSION_KEY,
  loadChatTabs,
  loadHistoryOpen,
  openSessionInTabs,
  saveChatTabs,
  saveHistoryOpen,
  setTabSession,
} from "./chatTabs";

afterEach(() => localStorage.clear());

const two = {
  tabs: [
    { id: "a", sessionId: "s1" },
    { id: "b", sessionId: "s2" },
  ],
  activeId: "a",
};

describe("loadChatTabs", () => {
  it("opens the single chat the Chat tab kept before it had tabs", () => {
    localStorage.setItem(LEGACY_CHAT_SESSION_KEY, "old-session");
    const state = loadChatTabs();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.sessionId).toBe("old-session");
    expect(state.activeId).toBe(state.tabs[0]!.id);
  });

  it("restores saved tabs and the active one", () => {
    saveChatTabs({ ...two, activeId: "b" });
    expect(loadChatTabs()).toEqual({ ...two, activeId: "b" });
  });

  it("falls back to one empty tab when the saved value is unreadable", () => {
    localStorage.setItem(CHAT_TABS_KEY, "{not json");
    const state = loadChatTabs();
    expect(state.tabs).toEqual([{ id: state.activeId, sessionId: null }]);
  });

  it("drops malformed tabs and focuses the first when the active one is gone", () => {
    localStorage.setItem(
      CHAT_TABS_KEY,
      JSON.stringify({ tabs: [{ id: 3 }, { id: "x", sessionId: "s" }], activeId: "gone" }),
    );
    expect(loadChatTabs()).toEqual({ tabs: [{ id: "x", sessionId: "s" }], activeId: "x" });
  });
});

describe("loadHistoryOpen", () => {
  it("shows the history until it is hidden, and remembers that", () => {
    expect(loadHistoryOpen()).toBe(true);
    saveHistoryOpen(false);
    expect(loadHistoryOpen()).toBe(false);
  });
});

describe("openSessionInTabs", () => {
  const idle = { newTabId: "new", activeTabIdle: true };
  const empty = { tabs: [{ id: "a", sessionId: null }], activeId: "a" };

  it("focuses the tab that already has the chat", () => {
    expect(openSessionInTabs(two, "s2", idle)).toEqual({ ...two, activeId: "b" });
  });

  it("opens a chat in the active tab when that tab is still empty", () => {
    expect(openSessionInTabs(empty, "s9", idle)).toEqual({
      tabs: [{ id: "a", sessionId: "s9" }],
      activeId: "a",
    });
  });

  it("leaves an empty tab whose first message is on its way", () => {
    const state = openSessionInTabs(empty, "s9", { newTabId: "new", activeTabIdle: false });
    expect(state.tabs).toEqual([
      { id: "a", sessionId: null },
      { id: "new", sessionId: "s9" },
    ]);
    expect(state.activeId).toBe("new");
  });

  it("opens a new tab when the active one already has a chat", () => {
    const state = openSessionInTabs(two, "s9", idle);
    expect(state.tabs.map((t) => t.id)).toEqual(["a", "b", "new"]);
    expect(state.activeId).toBe("new");
  });
});

describe("closeTab", () => {
  it("focuses the neighbour of the active tab it closes", () => {
    const three = addTab(two, "c");
    expect(closeTab({ ...three, activeId: "b" }, "b", "x").activeId).toBe("c");
    expect(closeTab(three, "c", "x").activeId).toBe("b");
  });

  it("keeps the active tab when another one closes", () => {
    expect(closeTab(two, "b", "x")).toEqual({ tabs: [two.tabs[0]!], activeId: "a" });
  });

  it("leaves one empty tab after the last one closes", () => {
    const only = { tabs: [{ id: "a", sessionId: "s1" }], activeId: "a" };
    expect(closeTab(only, "a", "fresh")).toEqual({
      tabs: [{ id: "fresh", sessionId: null }],
      activeId: "fresh",
    });
  });
});

describe("setTabSession", () => {
  it("returns the same state when nothing changes", () => {
    expect(setTabSession(two, "a", "s1")).toBe(two);
  });

  it("records the chat a tab started", () => {
    expect(setTabSession(two, "b", "s3").tabs[1]).toEqual({ id: "b", sessionId: "s3" });
  });
});
