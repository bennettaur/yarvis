import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPtyBusy, killPty } from "../../../lib/pty";
import TerminalPanel, { type TerminalPanelHandle } from "../../TerminalPanel";
import {
  allLeafIds,
  firstLeafId,
  hasPane,
  leaf,
  nextFocusAfterRemove,
  type Pane,
  type PaneId,
  removePane,
  type SplitDirection,
  splitPane,
} from "./paneTree";

/**
 * A single terminal surface with iTerm-style tabs and splittable panes.
 *
 * Each surface is identified by a `storageKey` ("tab:terminal", "ws:<id>",
 * "omni:<sid>"). State (tabs, splits, focused pane) persists in localStorage
 * under that key. PTY session ids are derived as `${storageKey}/<tabUid>/<paneUid>`
 * so multiple surfaces can coexist without colliding.
 *
 * Keyboard shortcuts when this surface has focus:
 *  - Cmd+T:        new tab
 *  - Cmd+W:        close active tab (with confirm if a process is running)
 *  - Cmd+D:        split focused pane vertically (new pane to the right)
 *  - Cmd+Shift+D:  split focused pane horizontally (new pane below)
 */

interface Tab {
  id: string;
  title: string;
  root: Pane;
}

interface SurfaceState {
  tabs: Tab[];
  activeTabId: string;
  /** Last focused pane per tab — lets a tab switch restore the pane the user was in. */
  focused: Record<string, PaneId>;
}

let uidCounter = 0;
const uid = (kind: "t" | "p") => `${kind}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

function freshState(): SurfaceState {
  const paneId = uid("p");
  const tabId = uid("t");
  return {
    tabs: [{ id: tabId, title: "Terminal", root: leaf(paneId) }],
    activeTabId: tabId,
    focused: { [tabId]: paneId },
  };
}

function storageKeyFor(key: string) {
  return `yarvis.terminalTabs.${key}`;
}

function loadState(key: string): SurfaceState {
  try {
    const raw = localStorage.getItem(storageKeyFor(key));
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as SurfaceState;
    if (!parsed.tabs?.length) return freshState();
    return parsed;
  } catch {
    return freshState();
  }
}

function sessionId(storageKey: string, tabId: string, paneId: PaneId): string {
  return `${storageKey}/${tabId}/${paneId}`;
}

export default function TerminalTabs({
  storageKey,
  cwd,
}: {
  /** Stable namespace for this surface — both for localStorage and PTY ids. */
  storageKey: string;
  /** Working directory for freshly spawned shells in this surface. */
  cwd?: string;
}) {
  const [state, setState] = useState<SurfaceState>(() => loadState(storageKey));
  // Refs to xterm handles so a tab/pane switch can move focus into the right shell.
  const handlesRef = useRef<Map<string, TerminalPanelHandle | null>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Persist on every change. State changes are coarse (tab/split/focus) so this
  // is plenty cheap to do unconditionally.
  useEffect(() => {
    localStorage.setItem(storageKeyFor(storageKey), JSON.stringify(state));
  }, [storageKey, state]);

  const activeTab = useMemo(
    () => state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0],
    [state.tabs, state.activeTabId],
  );
  const focusedPane = activeTab ? (state.focused[activeTab.id] ?? firstLeafId(activeTab.root)) : "";

  const setFocusedPane = useCallback((tabId: string, paneId: PaneId) => {
    setState((prev) => {
      if (prev.focused[tabId] === paneId) return prev;
      return { ...prev, focused: { ...prev.focused, [tabId]: paneId } };
    });
  }, []);

  const focusPane = useCallback(
    (paneId: PaneId) => {
      // Defer to next frame so a freshly-mounted xterm has a textarea to focus.
      requestAnimationFrame(() => handlesRef.current.get(paneId)?.focus());
    },
    // handlesRef is stable
    [],
  );

  const openTab = useCallback(() => {
    setState((prev) => {
      const tabId = uid("t");
      const paneId = uid("p");
      const tab: Tab = {
        id: tabId,
        title: `Terminal ${prev.tabs.length + 1}`,
        root: leaf(paneId),
      };
      return {
        tabs: [...prev.tabs, tab],
        activeTabId: tabId,
        focused: { ...prev.focused, [tabId]: paneId },
      };
    });
  }, []);

  const selectTab = useCallback(
    (tabId: string) => {
      setState((prev) => (prev.activeTabId === tabId ? prev : { ...prev, activeTabId: tabId }));
      const pane = state.focused[tabId];
      if (pane) focusPane(pane);
    },
    [state.focused, focusPane],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const leafIds = allLeafIds(tab.root);
      // Heuristic: any pane busy → confirm. The user opted into "confirm if a
      // process is running"; idle shells close silently.
      const busyChecks = await Promise.all(
        leafIds.map((p) => isPtyBusy(sessionId(storageKey, tabId, p)).catch(() => false)),
      );
      const busy = busyChecks.some(Boolean);
      if (busy) {
        const ok = window.confirm(
          `“${tab.title}” has a running process. Close it and kill the process?`,
        );
        if (!ok) return;
      }
      await Promise.all(
        leafIds.map((p) => killPty(sessionId(storageKey, tabId, p)).catch(() => undefined)),
      );
      setState((prev) => {
        const remaining = prev.tabs.filter((t) => t.id !== tabId);
        const { [tabId]: _omit, ...focused } = prev.focused;
        if (remaining.length === 0) {
          const fresh = freshState();
          return fresh;
        }
        const activeTabId =
          prev.activeTabId === tabId ? (remaining[0]?.id ?? "") : prev.activeTabId;
        return { tabs: remaining, activeTabId, focused };
      });
    },
    [state.tabs, storageKey],
  );

  const splitFocused = useCallback(
    (direction: SplitDirection) => {
      if (!activeTab) return;
      const target = focusedPane;
      const newId = uid("p");
      setState((prev) => {
        const tabs = prev.tabs.map((t) =>
          t.id === activeTab.id ? { ...t, root: splitPane(t.root, target, direction, newId) } : t,
        );
        return { ...prev, tabs, focused: { ...prev.focused, [activeTab.id]: newId } };
      });
      focusPane(newId);
    },
    [activeTab, focusedPane, focusPane],
  );

  const closePane = useCallback(
    async (paneId: PaneId) => {
      if (!activeTab) return;
      const sid = sessionId(storageKey, activeTab.id, paneId);
      const busy = await isPtyBusy(sid).catch(() => false);
      if (busy) {
        const ok = window.confirm(
          "This pane has a running process. Close it and kill the process?",
        );
        if (!ok) return;
      }
      await killPty(sid).catch(() => undefined);
      // Compute the next focused pane against the current tree before we update it.
      const next = nextFocusAfterRemove(activeTab.root, paneId);
      if (next === null) {
        // Last pane in the tab: collapse the tab too.
        await closeTab(activeTab.id);
        return;
      }
      setState((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => {
          if (t.id !== activeTab.id) return t;
          const root = removePane(t.root, paneId);
          // null is impossible here because we just confirmed `next` exists.
          return root ? { ...t, root } : t;
        }),
        focused: { ...prev.focused, [activeTab.id]: next },
      }));
      focusPane(next);
    },
    [activeTab, storageKey, closeTab, focusPane],
  );

  // Keyboard shortcuts — fire only when the focus is inside this surface so a
  // background terminal tab doesn't react to keystrokes meant for another view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root?.contains(document.activeElement)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        openTab();
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        if (activeTab) void closeTab(activeTab.id);
      } else if (key === "d") {
        e.preventDefault();
        e.stopPropagation();
        // iTerm semantics: Cmd+D = vertical divider (new pane right),
        // Cmd+Shift+D = horizontal divider (new pane below).
        splitFocused(e.shiftKey ? "horizontal" : "vertical");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeTab, openTab, closeTab, splitFocused]);

  // Defensive: a saved focus may point at a leaf that no longer exists (e.g.
  // a stale localStorage from a previous schema). Snap it back to a real leaf.
  useEffect(() => {
    if (!activeTab) return;
    const fp = state.focused[activeTab.id];
    if (!fp || !hasPane(activeTab.root, fp)) {
      setFocusedPane(activeTab.id, firstLeafId(activeTab.root));
    }
  }, [activeTab, state.focused, setFocusedPane]);

  if (!activeTab) return null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 w-full flex-col bg-[#09090b]">
      <TabStrip
        tabs={state.tabs}
        activeId={activeTab.id}
        onSelect={selectTab}
        onClose={(id) => void closeTab(id)}
        onNew={openTab}
      />
      <div className="min-h-0 flex-1">
        <PaneTreeView
          pane={activeTab.root}
          tabId={activeTab.id}
          storageKey={storageKey}
          cwd={cwd}
          focusedPane={focusedPane}
          onPaneFocus={(p) => setFocusedPane(activeTab.id, p)}
          onPaneClose={(p) => void closePane(p)}
          handles={handlesRef.current}
        />
      </div>
    </div>
  );
}

function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: Tab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-zinc-800 bg-zinc-950 px-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs ${
                active
                  ? "border-indigo-400 text-zinc-100"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="max-w-40 truncate"
                title={t.title}
              >
                {t.title}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.id)}
                aria-label={`Close ${t.title}`}
                title="Close tab (⌘W)"
                className="rounded px-1 text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNew}
        title="New tab (⌘T)"
        aria-label="New tab"
        className="shrink-0 rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        +
      </button>
    </div>
  );
}

function PaneTreeView({
  pane,
  tabId,
  storageKey,
  cwd,
  focusedPane,
  onPaneFocus,
  onPaneClose,
  handles,
}: {
  pane: Pane;
  tabId: string;
  storageKey: string;
  cwd?: string;
  focusedPane: PaneId;
  onPaneFocus: (p: PaneId) => void;
  onPaneClose: (p: PaneId) => void;
  handles: Map<string, TerminalPanelHandle | null>;
}) {
  if (pane.kind === "leaf") {
    const active = pane.id === focusedPane;
    const sid = sessionId(storageKey, tabId, pane.id);
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: focus tracker; xterm's textarea owns keyboard input
      <div
        className={`group relative h-full min-h-0 w-full ${
          active ? "ring-1 ring-inset ring-indigo-500/40" : ""
        }`}
        onMouseDown={() => onPaneFocus(pane.id)}
      >
        <TerminalPanel
          sessionId={sid}
          cwd={cwd}
          embedded
          onFocusRequested={() => onPaneFocus(pane.id)}
          panelRef={(h) => {
            if (h) handles.set(pane.id, h);
            else handles.delete(pane.id);
          }}
        />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPaneClose(pane.id);
          }}
          title="Close pane"
          aria-label="Close pane"
          className="absolute right-1 top-1 rounded bg-zinc-900/80 px-1 text-xs text-zinc-400 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100"
        >
          ×
        </button>
      </div>
    );
  }
  const flexDir = pane.direction === "vertical" ? "flex-row" : "flex-col";
  return (
    <div className={`flex h-full min-h-0 w-full ${flexDir}`}>
      <div className="min-h-0 min-w-0 flex-1">
        <PaneTreeView
          pane={pane.first}
          tabId={tabId}
          storageKey={storageKey}
          cwd={cwd}
          focusedPane={focusedPane}
          onPaneFocus={onPaneFocus}
          onPaneClose={onPaneClose}
          handles={handles}
        />
      </div>
      <div
        className={
          pane.direction === "vertical" ? "w-px shrink-0 bg-zinc-800" : "h-px shrink-0 bg-zinc-800"
        }
        aria-hidden="true"
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaneTreeView
          pane={pane.second}
          tabId={tabId}
          storageKey={storageKey}
          cwd={cwd}
          focusedPane={focusedPane}
          onPaneFocus={onPaneFocus}
          onPaneClose={onPaneClose}
          handles={handles}
        />
      </div>
    </div>
  );
}
