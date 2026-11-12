/** localStorage key under which the Chat tab's open tabs are kept. */
export const CHAT_TABS_KEY = "yarvis.chat.tabs";

/**
 * Where the Chat tab kept its one open session before it had tabs. Only read,
 * once, to turn that session into the first tab.
 */
export const LEGACY_CHAT_SESSION_KEY = "yarvis.chat.sessionId";

const HISTORY_OPEN_KEY = "yarvis.chat.historyOpen";

/** One open chat on the Chat tab. `sessionId` is null until its first message. */
export interface ChatTab {
  id: string;
  sessionId: string | null;
}

export interface ChatTabsState {
  tabs: ChatTab[];
  activeId: string;
}

export function createTabId(): string {
  return crypto.randomUUID();
}

function singleTab(id: string, sessionId: string | null = null): ChatTabsState {
  return { tabs: [{ id, sessionId }], activeId: id };
}

function isTab(value: unknown): value is ChatTab {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === "string" && (t.sessionId === null || typeof t.sessionId === "string");
}

/** The tabs left open last time, or one tab holding the pre-tabs session. */
export function loadChatTabs(): ChatTabsState {
  try {
    const raw = localStorage.getItem(CHAT_TABS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
      const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTab) : [];
      if (tabs.length > 0) {
        const activeId = tabs.some((t) => t.id === parsed.activeId)
          ? (parsed.activeId as string)
          : tabs[0]!.id;
        return { tabs, activeId };
      }
    }
    return singleTab(createTabId(), localStorage.getItem(LEGACY_CHAT_SESSION_KEY));
  } catch {
    return singleTab(createTabId());
  }
}

export function saveChatTabs(state: ChatTabsState): void {
  try {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(state));
  } catch {
    // Tabs reopen only as a convenience; losing them is fine.
  }
}

/** Whether the chat history sidebar was showing last time. Shown by default. */
export function loadHistoryOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveHistoryOpen(open: boolean): void {
  try {
    localStorage.setItem(HISTORY_OPEN_KEY, String(open));
  } catch {
    // Only a preference.
  }
}

export function addTab(state: ChatTabsState, newTabId: string): ChatTabsState {
  return { tabs: [...state.tabs, { id: newTabId, sessionId: null }], activeId: newTabId };
}

/**
 * Brings a chat on screen. A tab that already has it is focused, so one chat
 * never runs in two tabs at once. Otherwise the active tab takes it if it is
 * empty and `activeTabIdle` (its first message isn't on its way), and failing
 * that it opens in a new tab with `newTabId`.
 */
export function openSessionInTabs(
  state: ChatTabsState,
  sessionId: string,
  { newTabId, activeTabIdle }: { newTabId: string; activeTabIdle: boolean },
): ChatTabsState {
  const existing = state.tabs.find((t) => t.sessionId === sessionId);
  if (existing) return { ...state, activeId: existing.id };
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active && active.sessionId === null && activeTabIdle) {
    return setTabSession(state, active.id, sessionId);
  }
  return { tabs: [...state.tabs, { id: newTabId, sessionId }], activeId: newTabId };
}

/**
 * Closes a tab and focuses its neighbour. Closing the last tab leaves an
 * empty one with `newTabId`, so the Chat tab always has a composer.
 */
export function closeTab(state: ChatTabsState, tabId: string, newTabId: string): ChatTabsState {
  const at = state.tabs.findIndex((t) => t.id === tabId);
  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0) return singleTab(newTabId);
  if (state.activeId !== tabId) return { ...state, tabs };
  return { tabs, activeId: tabs[Math.min(at, tabs.length - 1)]!.id };
}

export function setTabSession(
  state: ChatTabsState,
  tabId: string,
  sessionId: string | null,
): ChatTabsState {
  const tab = state.tabs.find((t) => t.id === tabId);
  // The same object back when nothing changes, so React skips the re-render and the save.
  if (!tab || tab.sessionId === sessionId) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
  };
}
