import { PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ChatSession, listSessions } from "../lib/chat";
import {
  addTab,
  type ChatTab,
  type ChatTabsState,
  closeTab,
  loadChatTabs,
  openSessionInTabs,
  saveChatTabs,
  setTabSession,
} from "../lib/chatTabs";
import { type DisplayError, formatError } from "../lib/errors";
import ChatPanel, { type ChatPanelStatus } from "./ChatPanel";
import ErrorNotice from "./ErrorNotice";

const HISTORY_OPEN_KEY = "yarvis.chat.historyOpen";

function readHistoryOpen(): boolean {
  try {
    return localStorage.getItem(HISTORY_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function tabLabel(tab: ChatTab, sessions: ChatSession[]): string {
  if (!tab.sessionId) return "New chat";
  return sessions.find((s) => s.id === tab.sessionId)?.title ?? "Untitled chat";
}

/**
 * The Chat tab: several chats open side by side as tabs, with a collapsible
 * list of every chat beside them. Each tab is its own `ChatPanel`, and all of
 * them stay mounted, so a reply keeps streaming in a tab the user has left.
 *
 * `requestedSessionId` opens that chat, focusing the tab that already has it;
 * `requestedArtifactId` opens an artifact beside the active tab's thread.
 */
export default function ChatTabs({
  active,
  requestedSessionId,
  onRequestConsumed,
  requestedArtifactId,
  onArtifactRequestConsumed,
}: {
  active: boolean;
  requestedSessionId: string | null;
  onRequestConsumed: () => void;
  requestedArtifactId: string | null;
  onArtifactRequestConsumed: () => void;
}) {
  const [state, setState] = useState<ChatTabsState>(loadChatTabs);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Sessions each tab still has to load: every saved tab on mount, and a tab
  // asked to re-read its chat, which a scheduled task may have added to.
  const [pendingLoads, setPendingLoads] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      state.tabs.flatMap((t) => (t.sessionId ? [[t.id, t.sessionId] as const] : [])),
    ),
  );
  const [statuses, setStatuses] = useState<Record<string, ChatPanelStatus>>({});
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionsError, setSessionsError] = useState<DisplayError | null>(null);
  const [historyOpen, setHistoryOpen] = useState(readHistoryOpen);

  useEffect(() => saveChatTabs(state), [state]);

  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_OPEN_KEY, String(historyOpen));
    } catch {
      // Only a preference.
    }
  }, [historyOpen]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions());
      setSessionsError(null);
    } catch (e) {
      setSessionsError(formatError(e));
    }
  }, []);

  // Titles are assigned by the sidecar from a chat's first message, and other
  // surfaces add chats while this tab sits hidden.
  useEffect(() => {
    if (active) void refreshSessions();
  }, [active, refreshSessions]);

  const openSession = useCallback((sessionId: string) => {
    const { state: next, tabId } = openSessionInTabs(stateRef.current, sessionId);
    stateRef.current = next;
    setState(next);
    setPendingLoads((loads) => ({ ...loads, [tabId]: sessionId }));
  }, []);

  useEffect(() => {
    if (!requestedSessionId) return;
    openSession(requestedSessionId);
    onRequestConsumed();
  }, [requestedSessionId, openSession, onRequestConsumed]);

  const onSessionChange = useCallback(
    (tabId: string, sessionId: string | null) => {
      // A panel reports null while its saved chat is still loading; that must
      // not wipe the tab's session.
      if (!sessionId) return;
      setState((prev) => setTabSession(prev, tabId, sessionId));
      // A chat this tab just started has no row in the list yet.
      void refreshSessions();
    },
    [refreshSessions],
  );

  const busyTabs = useRef(new Set<string>());
  const onStatusChange = useCallback(
    (tabId: string, status: ChatPanelStatus) => {
      // A reply that just finished is when a new chat's title appears.
      if (busyTabs.current.has(tabId) && !status.busy) void refreshSessions();
      if (status.busy) busyTabs.current.add(tabId);
      else busyTabs.current.delete(tabId);
      setStatuses((prev) => ({ ...prev, [tabId]: status }));
    },
    [refreshSessions],
  );

  const consumeLoad = useCallback((tabId: string) => {
    setPendingLoads((loads) => {
      const { [tabId]: _, ...rest } = loads;
      return rest;
    });
  }, []);

  const close = (tabId: string) => {
    setState((prev) => closeTab(prev, tabId));
    consumeLoad(tabId);
    busyTabs.current.delete(tabId);
    setStatuses(({ [tabId]: _, ...rest }) => rest);
  };

  const openTabSessions = new Set(state.tabs.map((t) => t.sessionId));
  const activeSessionId = state.tabs.find((t) => t.id === state.activeId)?.sessionId ?? null;

  return (
    <div className="flex h-full min-h-0">
      {historyOpen && (
        <aside
          aria-label="Chat history"
          className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950"
        >
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium tracking-wide text-zinc-400 uppercase">Chats</span>
            <button
              type="button"
              onClick={() => setHistoryOpen(false)}
              aria-label="Hide chat history"
              title="Hide chat history"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <PanelLeftCloseIcon className="size-4" />
            </button>
          </div>
          {sessionsError && (
            <div className="px-2">
              <ErrorNotice error={sessionsError} onDismiss={() => setSessionsError(null)} />
            </div>
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            {sessions.map((s) => {
              const current = s.id === activeSessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openSession(s.id)}
                    title={s.title ?? "Untitled chat"}
                    aria-current={current ? "true" : undefined}
                    className={`block w-full truncate rounded px-2 py-1.5 text-left text-sm ${
                      current
                        ? "bg-zinc-800 text-zinc-100"
                        : openTabSessions.has(s.id)
                          ? "text-zinc-200 hover:bg-zinc-900"
                          : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                    }`}
                  >
                    {s.title ?? "Untitled chat"}
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          role="tablist"
          aria-label="Open chats"
          className="flex shrink-0 items-center gap-0.5 border-b border-zinc-800 bg-zinc-950 px-1"
        >
          {!historyOpen && (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-label="Show chat history"
              title="Show chat history"
              className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <PanelLeftOpenIcon className="size-4" />
            </button>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            {state.tabs.map((t) => {
              const selected = t.id === state.activeId;
              const status = statuses[t.id];
              const label = tabLabel(t, sessions);
              return (
                <div
                  key={t.id}
                  className={`group flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs ${
                    selected
                      ? "border-indigo-400 text-zinc-100"
                      : status?.awaitingApproval
                        ? "border-transparent text-amber-300 hover:text-amber-200"
                        : "border-transparent text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setState((prev) => ({ ...prev, activeId: t.id }))}
                    title={status?.awaitingApproval ? `${label} — needs your approval` : label}
                    className="flex max-w-48 items-center gap-1 truncate"
                  >
                    {status?.awaitingApproval ? (
                      <span className="text-amber-400">●</span>
                    ) : status?.busy ? (
                      <span className="animate-pulse text-emerald-400">●</span>
                    ) : null}
                    <span className="truncate">{label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => close(t.id)}
                    aria-label={`Close ${label}`}
                    title="Close tab"
                    className={`rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${
                      selected ? "" : "opacity-0 group-hover:opacity-100"
                    }`}
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setState((prev) => addTab(prev))}
            aria-label="New chat"
            title="New chat"
            className="shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <PlusIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {state.tabs.map((t) => {
            const selected = active && t.id === state.activeId;
            return (
              <div key={t.id} className={t.id === state.activeId ? "h-full" : "hidden"}>
                <ChatTabPanel
                  tabId={t.id}
                  active={selected}
                  requestedSessionId={pendingLoads[t.id] ?? null}
                  onLoadConsumed={consumeLoad}
                  requestedArtifactId={t.id === state.activeId ? requestedArtifactId : null}
                  onArtifactRequestConsumed={onArtifactRequestConsumed}
                  onSessionChange={onSessionChange}
                  onStatusChange={onStatusChange}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Binds a `ChatPanel`'s callbacks to its tab, so they stay stable across renders. */
function ChatTabPanel({
  tabId,
  active,
  requestedSessionId,
  onLoadConsumed,
  requestedArtifactId,
  onArtifactRequestConsumed,
  onSessionChange,
  onStatusChange,
}: {
  tabId: string;
  active: boolean;
  requestedSessionId: string | null;
  onLoadConsumed: (tabId: string) => void;
  requestedArtifactId: string | null;
  onArtifactRequestConsumed: () => void;
  onSessionChange: (tabId: string, sessionId: string | null) => void;
  onStatusChange: (tabId: string, status: ChatPanelStatus) => void;
}) {
  const consumed = useCallback(() => onLoadConsumed(tabId), [onLoadConsumed, tabId]);
  const sessionChanged = useCallback(
    (sessionId: string | null) => onSessionChange(tabId, sessionId),
    [onSessionChange, tabId],
  );
  const statusChanged = useCallback(
    (status: ChatPanelStatus) => onStatusChange(tabId, status),
    [onStatusChange, tabId],
  );
  return (
    <ChatPanel
      active={active}
      focusOnShow
      showSessionControls={false}
      requestedSessionId={requestedSessionId}
      onRequestConsumed={consumed}
      requestedArtifactId={requestedArtifactId}
      onArtifactRequestConsumed={onArtifactRequestConsumed}
      onSessionChange={sessionChanged}
      onStatusChange={statusChanged}
    />
  );
}
