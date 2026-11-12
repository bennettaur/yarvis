import { CHAT_TAB_SESSION_KEY } from "./useChatThread";

/** localStorage key under which the Chat tab's open tabs are kept. */
export const CHAT_TABS_KEY = "yarvis.chat.tabs";

/** One open chat on the Chat tab. `sessionId` is null until its first message. */
export interface ChatTab {
  id: string;
  sessionId: string | null;
}

export interface ChatTabsState {
  tabs: ChatTab[];
  activeId: string;
}

export function newTabId(): string {
  return crypto.randomUUID();
}

function freshState(sessionId: string | null = null): ChatTabsState {
  const id = newTabId();
  return { tabs: [{ id, sessionId }], activeId: id };
}

function isTab(value: unknown): value is ChatTab {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === "string" && (t.sessionId === null || typeof t.sessionId === "string");
}

/**
 * The tabs left open last time. Before the Chat tab had tabs it kept one
 * session id, so a first load opens that chat in a single tab.
 */
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
    return freshState(localStorage.getItem(CHAT_TAB_SESSION_KEY));
  } catch {
    return freshState();
  }
}

export function saveChatTabs(state: ChatTabsState): void {
  try {
    localStorage.setItem(CHAT_TABS_KEY, JSON.stringify(state));
  } catch {
    // Tabs reopen only as a convenience; losing them is fine.
  }
}

export function addTab(state: ChatTabsState, id = newTabId()): ChatTabsState {
  return { tabs: [...state.tabs, { id, sessionId: null }], activeId: id };
}

/**
 * Brings a chat on screen. A tab that already has it is focused, so one chat
 * never runs in two tabs at once. Otherwise an empty active tab takes it, and
 * failing that it opens in a new tab.
 */
export function openSessionInTabs(
  state: ChatTabsState,
  sessionId: string,
  id = newTabId(),
): { state: ChatTabsState; tabId: string } {
  const existing = state.tabs.find((t) => t.sessionId === sessionId);
  if (existing) return { state: { ...state, activeId: existing.id }, tabId: existing.id };
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active && active.sessionId === null) {
    return { state: setTabSession(state, active.id, sessionId), tabId: active.id };
  }
  return {
    state: { tabs: [...state.tabs, { id, sessionId }], activeId: id },
    tabId: id,
  };
}

/**
 * Closes a tab and focuses its neighbour. Closing the last tab leaves an
 * empty one, so the Chat tab always has a composer.
 */
export function closeTab(state: ChatTabsState, tabId: string, id = newTabId()): ChatTabsState {
  const at = state.tabs.findIndex((t) => t.id === tabId);
  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== tabId);
  if (tabs.length === 0) return { tabs: [{ id, sessionId: null }], activeId: id };
  if (state.activeId !== tabId) return { ...state, tabs };
  return { tabs, activeId: tabs[Math.min(at, tabs.length - 1)]!.id };
}

export function setTabSession(
  state: ChatTabsState,
  tabId: string,
  sessionId: string | null,
): ChatTabsState {
  if (!state.tabs.some((t) => t.id === tabId && t.sessionId !== sessionId)) return state;
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, sessionId } : t)),
  };
}
