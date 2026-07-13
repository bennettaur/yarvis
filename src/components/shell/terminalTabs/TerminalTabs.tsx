import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isPtyBusy, killPty } from "../../../lib/pty";
import SplitPane from "../../SplitPane";
import TerminalPanel, { type TerminalPanelHandle } from "../../TerminalPanel";
import {
  allLeafIds,
  firstLeafId,
  hasPane,
  leaf,
  nextFocusAfterRemove,
  type Pane,
  type PaneId,
  type PanePath,
  removePane,
  type SplitDirection,
  setRatioAtPath,
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

/** A normal tab: a splittable tree of terminal panes. */
interface TerminalTab {
  id: string;
  title: string;
  kind: "terminal";
  root: Pane;
}

/**
 * A tab viewing the diff of a changed file. The tab only tracks which file it
 * shows (repo + path); the surface's owner supplies the actual renderer via
 * `renderFileDiff`. Tracking the file here is what lets us avoid opening the
 * same file twice — a repeat request just re-selects this tab.
 */
interface DiffTab {
  id: string;
  title: string;
  kind: "diff";
  repoId: string;
  path: string;
}

type Tab = TerminalTab | DiffTab;

/** Tab title for a diff tab: the file's basename, which is short and unique enough. */
const fileTitle = (path: string) => path.split("/").pop() || path;

/**
 * A tab bound to an externally-managed PTY session (e.g. a Claude session the
 * core spawned over the control channel). Unlike a normal tab it uses a fixed
 * session id rather than a derived one, is single-pane (not splittable), and is
 * shown only while the caller includes it.
 */
export interface PinnedTab {
  key: string;
  title: string;
  sessionId: string;
  cwd?: string;
  initialCommand?: string;
}

/** activeTabId value marking a pinned tab as selected. */
const PINNED_PREFIX = "pinned:";
const pinnedTabId = (key: string) => `${PINNED_PREFIX}${key}`;

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
    tabs: [{ id: tabId, title: "Terminal", kind: "terminal", root: leaf(paneId) }],
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
    // Backfill `kind` for states persisted before diff tabs existed: a tab with a
    // pane tree is a terminal tab.
    parsed.tabs = parsed.tabs.map((t) =>
      (t as Tab).kind ? t : ({ ...t, kind: "terminal" } as TerminalTab),
    );
    return parsed;
  } catch {
    return freshState();
  }
}

function sessionId(storageKey: string, tabId: string, paneId: PaneId): string {
  return `${storageKey}/${tabId}/${paneId}`;
}

/** A request to open (or re-focus) a diff tab for a changed file. */
export interface OpenFileDiff {
  repoId: string;
  path: string;
}

export default function TerminalTabs({
  storageKey,
  cwd,
  pinnedTabs = [],
  openFileDiff = null,
  onFileDiffOpened,
  renderFileDiff,
}: {
  /** Stable namespace for this surface — both for localStorage and PTY ids. */
  storageKey: string;
  /** Working directory for freshly spawned shells in this surface. */
  cwd?: string;
  /** Tabs bound to externally-managed sessions, shown whenever present. */
  pinnedTabs?: PinnedTab[];
  /**
   * A changed file to open in a diff tab. Setting this opens a new tab, or
   * re-focuses the existing tab already viewing that file. Cleared by the caller
   * via `onFileDiffOpened` once consumed, mirroring the request/consume pattern
   * used elsewhere for cross-component navigation.
   */
  openFileDiff?: OpenFileDiff | null;
  /** Called once an `openFileDiff` request has been handled. */
  onFileDiffOpened?: () => void;
  /** Supplies a diff tab's body. When omitted, diff tabs are not used. */
  renderFileDiff?: (file: OpenFileDiff) => ReactNode;
}) {
  const [state, setState] = useState<SurfaceState>(() => loadState(storageKey));
  // Refs to xterm handles so a tab/pane switch can move focus into the right shell.
  const handlesRef = useRef<Map<string, TerminalPanelHandle | null>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Pinned tab keys seen on the previous render, to detect newly-appeared ones.
  const prevPinnedKeysRef = useRef<string[]>([]);

  // Persist on every change. State changes are coarse (tab/split/focus) so this
  // is plenty cheap to do unconditionally.
  useEffect(() => {
    localStorage.setItem(storageKeyFor(storageKey), JSON.stringify(state));
  }, [storageKey, state]);

  const activePinned = useMemo(
    () => pinnedTabs.find((p) => state.activeTabId === pinnedTabId(p.key)) ?? null,
    [pinnedTabs, state.activeTabId],
  );
  // When a pinned tab is active, no regular tab is selected (undefined); the
  // body renders the pinned session instead of the pane tree.
  const activeTab = useMemo(() => {
    const match = state.tabs.find((t) => t.id === state.activeTabId);
    if (match) return match;
    return activePinned ? undefined : state.tabs[0];
  }, [state.tabs, state.activeTabId, activePinned]);
  const focusedPane =
    activeTab?.kind === "terminal"
      ? (state.focused[activeTab.id] ?? firstLeafId(activeTab.root))
      : "";

  // Reconcile pinned tabs: focus one that just appeared (e.g. a Claude session
  // that started), and fall back to a normal tab when the active pinned tab goes
  // away. Keyed on the set of keys, not the array identity.
  const pinnedKeysSig = pinnedTabs.map((p) => p.key).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on pinnedKeysSig; pinnedTabs identity changes each render
  useEffect(() => {
    const keys = pinnedTabs.map((p) => p.key);
    const appeared = keys.filter((k) => !prevPinnedKeysRef.current.includes(k));
    prevPinnedKeysRef.current = keys;
    setState((prev) => {
      if (prev.activeTabId.startsWith(PINNED_PREFIX)) {
        const activeKey = prev.activeTabId.slice(PINNED_PREFIX.length);
        if (!keys.includes(activeKey)) {
          return { ...prev, activeTabId: prev.tabs[0]?.id ?? "" };
        }
      }
      const first = appeared[0];
      if (first) return { ...prev, activeTabId: pinnedTabId(first) };
      return prev;
    });
  }, [pinnedKeysSig]);

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
      const terminalCount = prev.tabs.filter((t) => t.kind === "terminal").length;
      const tab: TerminalTab = {
        id: tabId,
        title: `Terminal ${terminalCount + 1}`,
        kind: "terminal",
        root: leaf(paneId),
      };
      return {
        tabs: [...prev.tabs, tab],
        activeTabId: tabId,
        focused: { ...prev.focused, [tabId]: paneId },
      };
    });
  }, []);

  // Open a diff tab for a changed file, or re-focus the tab already showing it.
  const openDiff = useCallback((file: OpenFileDiff) => {
    setState((prev) => {
      const existing = prev.tabs.find(
        (t) => t.kind === "diff" && t.repoId === file.repoId && t.path === file.path,
      );
      if (existing) {
        return prev.activeTabId === existing.id ? prev : { ...prev, activeTabId: existing.id };
      }
      const tabId = uid("t");
      const tab: DiffTab = {
        id: tabId,
        title: fileTitle(file.path),
        kind: "diff",
        repoId: file.repoId,
        path: file.path,
      };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: tabId };
    });
  }, []);

  // Consume an open-diff request from the surface owner, then signal completion
  // so a repeat click on the same (or another) file fires the effect again.
  useEffect(() => {
    if (!openFileDiff) return;
    openDiff(openFileDiff);
    onFileDiffOpened?.();
  }, [openFileDiff, openDiff, onFileDiffOpened]);

  const selectTab = useCallback(
    (tabId: string) => {
      setState((prev) => (prev.activeTabId === tabId ? prev : { ...prev, activeTabId: tabId }));
      const pane = state.focused[tabId];
      if (pane) focusPane(pane);
    },
    [state.focused, focusPane],
  );

  const selectPinned = useCallback((key: string) => {
    setState((prev) => ({ ...prev, activeTabId: pinnedTabId(key) }));
  }, []);

  // Closing a pinned tab ends its underlying session; the caller stops listing it
  // on its next poll, which removes the header.
  const closePinned = useCallback(async (pinned: PinnedTab) => {
    await killPty(pinned.sessionId).catch(() => undefined);
    setState((prev) =>
      prev.activeTabId === pinnedTabId(pinned.key)
        ? { ...prev, activeTabId: prev.tabs[0]?.id ?? "" }
        : prev,
    );
  }, []);

  const closeTab = useCallback(
    async (tabId: string) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // Diff tabs own no PTY, so they close with no busy check or kill.
      const leafIds = tab.kind === "terminal" ? allLeafIds(tab.root) : [];
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
      if (activeTab?.kind !== "terminal") return;
      const target = focusedPane;
      const newId = uid("p");
      setState((prev) => {
        const tabs = prev.tabs.map((t) =>
          t.id === activeTab.id && t.kind === "terminal"
            ? { ...t, root: splitPane(t.root, target, direction, newId) }
            : t,
        );
        return { ...prev, tabs, focused: { ...prev.focused, [activeTab.id]: newId } };
      });
      focusPane(newId);
    },
    [activeTab, focusedPane, focusPane],
  );

  const resizePane = useCallback((tabId: string, path: PanePath, ratio: number) => {
    setState((prev) => ({
      ...prev,
      tabs: prev.tabs.map((t) =>
        t.id === tabId && t.kind === "terminal"
          ? { ...t, root: setRatioAtPath(t.root, path, ratio) }
          : t,
      ),
    }));
  }, []);

  const closePane = useCallback(
    async (paneId: PaneId) => {
      if (activeTab?.kind !== "terminal") return;
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
          if (t.id !== activeTab.id || t.kind !== "terminal") return t;
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
      // Cmd-only (not Ctrl) — Ctrl+D/T/W are reserved for the shell (EOF,
      // transpose-chars, kill-word-back) and must reach the terminal.
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
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
    if (activeTab?.kind !== "terminal") return;
    const fp = state.focused[activeTab.id];
    if (!fp || !hasPane(activeTab.root, fp)) {
      setFocusedPane(activeTab.id, firstLeafId(activeTab.root));
    }
  }, [activeTab, state.focused, setFocusedPane]);

  if (!activeTab && !activePinned) return null;

  return (
    <div ref={rootRef} className="flex h-full min-h-0 w-full min-w-0 flex-col bg-[#09090b]">
      <TabStrip
        tabs={state.tabs}
        pinnedTabs={pinnedTabs}
        activeId={state.activeTabId}
        onSelect={selectTab}
        onSelectPinned={selectPinned}
        onClose={(id) => void closeTab(id)}
        onClosePinned={(p) => void closePinned(p)}
        onNew={openTab}
      />
      <div className="min-h-0 min-w-0 flex-1">
        {activePinned ? (
          <TerminalPanel
            sessionId={activePinned.sessionId}
            cwd={activePinned.cwd}
            initialCommand={activePinned.initialCommand}
            embedded
          />
        ) : activeTab?.kind === "diff" ? (
          (renderFileDiff?.({ repoId: activeTab.repoId, path: activeTab.path }) ?? null)
        ) : activeTab ? (
          <PaneTreeView
            pane={activeTab.root}
            path={[]}
            tabId={activeTab.id}
            storageKey={storageKey}
            cwd={cwd}
            focusedPane={focusedPane}
            onPaneFocus={(p) => setFocusedPane(activeTab.id, p)}
            onPaneClose={(p) => void closePane(p)}
            onPaneResize={(path, ratio) => resizePane(activeTab.id, path, ratio)}
            handles={handlesRef.current}
          />
        ) : null}
      </div>
    </div>
  );
}

function TabStrip({
  tabs,
  pinnedTabs,
  activeId,
  onSelect,
  onSelectPinned,
  onClose,
  onClosePinned,
  onNew,
}: {
  tabs: Tab[];
  pinnedTabs: PinnedTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onSelectPinned: (key: string) => void;
  onClose: (id: string) => void;
  onClosePinned: (pinned: PinnedTab) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-zinc-800 bg-zinc-950 px-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {pinnedTabs.map((p) => {
          const active = activeId === `${PINNED_PREFIX}${p.key}`;
          return (
            <div
              key={`pinned:${p.key}`}
              className={`group flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs ${
                active
                  ? "border-indigo-400 text-zinc-100"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectPinned(p.key)}
                className="flex max-w-40 items-center gap-1 truncate"
                title={p.title}
              >
                <span className="text-emerald-400">●</span>
                {p.title}
              </button>
              <button
                type="button"
                onClick={() => onClosePinned(p)}
                aria-label={`End ${p.title}`}
                title="End session"
                className="rounded px-1.5 py-0.5 text-sm leading-none text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          );
        })}
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
                className="flex max-w-40 items-center gap-1 truncate"
                title={t.kind === "diff" ? t.path : t.title}
              >
                {t.kind === "diff" && <span className="text-sky-400">±</span>}
                {t.title}
              </button>
              <button
                type="button"
                onClick={() => onClose(t.id)}
                aria-label={`Close ${t.title}`}
                title="Close tab (⌘W)"
                className="rounded px-1.5 py-0.5 text-sm leading-none text-zinc-500 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 group-hover:opacity-100"
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
  path,
  tabId,
  storageKey,
  cwd,
  focusedPane,
  onPaneFocus,
  onPaneClose,
  onPaneResize,
  handles,
}: {
  pane: Pane;
  /** This node's location in the tree, so a divider drag names its split. */
  path: PanePath;
  tabId: string;
  storageKey: string;
  cwd?: string;
  focusedPane: PaneId;
  onPaneFocus: (p: PaneId) => void;
  onPaneClose: (p: PaneId) => void;
  onPaneResize: (path: PanePath, ratio: number) => void;
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
          className="absolute right-1 top-1 rounded bg-zinc-900/80 px-1.5 py-0.5 text-sm leading-none text-zinc-400 opacity-0 hover:bg-zinc-800 hover:text-zinc-100 group-hover:opacity-100"
        >
          ×
        </button>
      </div>
    );
  }
  // paneTree "vertical" = vertical divider / panes side-by-side, which is a
  // "horizontal" flow for SplitPane; "horizontal" = stacked panes = "vertical".
  return (
    <SplitPane
      className="h-full w-full"
      orientation={pane.direction === "vertical" ? "horizontal" : "vertical"}
      ratio={pane.ratio ?? 0.5}
      onRatioChange={(ratio) => onPaneResize(path, ratio)}
      first={
        <PaneTreeView
          pane={pane.first}
          path={[...path, "first"]}
          tabId={tabId}
          storageKey={storageKey}
          cwd={cwd}
          focusedPane={focusedPane}
          onPaneFocus={onPaneFocus}
          onPaneClose={onPaneClose}
          onPaneResize={onPaneResize}
          handles={handles}
        />
      }
      second={
        <PaneTreeView
          pane={pane.second}
          path={[...path, "second"]}
          tabId={tabId}
          storageKey={storageKey}
          cwd={cwd}
          focusedPane={focusedPane}
          onPaneFocus={onPaneFocus}
          onPaneClose={onPaneClose}
          onPaneResize={onPaneResize}
          handles={handles}
        />
      }
    />
  );
}
