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
import { reorderTabs } from "./reorderTabs";
import {
  type DiffTab,
  type InitialTab,
  isPinnedTabId,
  loadState,
  type PinnedTab,
  pinnedKeyOf,
  pinnedTabId,
  type SetupLogTab,
  type SurfaceState,
  stateAfterCloseTab,
  storageKeyFor,
  type Tab,
  type TerminalTab,
  uid,
} from "./surfaceState";

export type { InitialTab, PinnedTab } from "./surfaceState";

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

/** Tab title for a diff tab: the file's basename, which is short and unique enough. */
const fileTitle = (path: string) => path.split("/").pop() || path;

function sessionId(storageKey: string, tabId: string, paneId: PaneId): string {
  return `${storageKey}/${tabId}/${paneId}`;
}

/** A request to open (or re-focus) a diff tab for a changed file. */
export interface OpenFileDiff {
  repoId: string;
  path: string;
}

/** A request to open (or re-focus) a setup-log tab for a workspace repo. */
export interface OpenSetupLog {
  workspaceRepoId: string;
  /** Tab title, typically the repo's name. */
  title: string;
}

export default function TerminalTabs({
  storageKey,
  cwd,
  pinnedTabs = [],
  onClosePinned,
  initialTab = "terminal",
  openFileDiff = null,
  onFileDiffOpened,
  renderFileDiff,
  openSetupLog = null,
  onSetupLogOpened,
  renderSetupLog,
}: {
  /** Stable namespace for this surface — both for localStorage and PTY ids. */
  storageKey: string;
  /** Working directory for freshly spawned shells in this surface. */
  cwd?: string;
  /** Tabs bound to externally-managed sessions, shown whenever present. */
  pinnedTabs?: PinnedTab[];
  /**
   * Called after the user closes a pinned tab and its session has been killed.
   * The owner decides what a pinned tab's presence means, so only it can drop
   * the tab — without this the header would linger (and, for a tab carrying an
   * `initialCommand`, relaunch its session on the next reattach).
   */
  onClosePinned?: (pinned: PinnedTab) => void;
  /** What this surface shows with no tabs of its own; see `InitialTab`. */
  initialTab?: InitialTab;
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
  /**
   * A workspace repo's setup log to open in a tab, using the same
   * request/consume pattern as `openFileDiff`. Setting this opens a new tab or
   * re-focuses the existing one for that repo; cleared via `onSetupLogOpened`.
   */
  openSetupLog?: OpenSetupLog | null;
  /** Called once an `openSetupLog` request has been handled. */
  onSetupLogOpened?: () => void;
  /** Supplies a setup-log tab's body. When omitted, setup-log tabs are not used. */
  renderSetupLog?: (req: Pick<OpenSetupLog, "workspaceRepoId">) => ReactNode;
}) {
  const [state, setState] = useState<SurfaceState>(() => loadState(storageKey, initialTab));
  // Refs to xterm handles so a tab/pane switch can move focus into the right shell.
  const handlesRef = useRef<Map<string, TerminalPanelHandle | null>>(new Map());
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Pinned tab keys seen on the previous render, to detect newly-appeared ones.
  const prevPinnedKeysRef = useRef<string[]>([]);
  // Where selection lands if the last regular tab is closed. A primitive, so the
  // close callbacks that depend on it stay stable across renders — `pinnedTabs`
  // is a fresh array each time.
  const firstPinnedKey = pinnedTabs[0]?.key ?? null;

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
      if (isPinnedTabId(prev.activeTabId)) {
        const activeKey = pinnedKeyOf(prev.activeTabId);
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

  // Open a setup-log tab for a workspace repo, or re-focus the tab already
  // showing it (a repo has a single setup log, so dedupe on its id).
  const openSetup = useCallback((req: OpenSetupLog) => {
    setState((prev) => {
      const existing = prev.tabs.find(
        (t) => t.kind === "setup" && t.workspaceRepoId === req.workspaceRepoId,
      );
      if (existing) {
        return prev.activeTabId === existing.id ? prev : { ...prev, activeTabId: existing.id };
      }
      const tabId = uid("t");
      const tab: SetupLogTab = {
        id: tabId,
        title: req.title,
        kind: "setup",
        workspaceRepoId: req.workspaceRepoId,
      };
      return { ...prev, tabs: [...prev.tabs, tab], activeTabId: tabId };
    });
  }, []);

  // Consume an open-setup-log request, mirroring the open-diff flow above.
  useEffect(() => {
    if (!openSetupLog) return;
    openSetup(openSetupLog);
    onSetupLogOpened?.();
  }, [openSetupLog, openSetup, onSetupLogOpened]);

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

  const reorder = useCallback((dragId: string, targetId: string, position: "before" | "after") => {
    setState((prev) => {
      const next = reorderTabs(prev.tabs, dragId, targetId, position);
      return next === prev.tabs ? prev : { ...prev, tabs: next };
    });
  }, []);

  // Closing a pinned tab ends its underlying session and tells the owner, which
  // is what actually removes the header — this surface doesn't decide whether a
  // pinned tab exists.
  const closePinned = useCallback(
    async (pinned: PinnedTab) => {
      await killPty(pinned.sessionId).catch(() => undefined);
      setState((prev) =>
        prev.activeTabId === pinnedTabId(pinned.key)
          ? { ...prev, activeTabId: prev.tabs[0]?.id ?? "" }
          : prev,
      );
      onClosePinned?.(pinned);
    },
    [onClosePinned],
  );

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
      setState((prev) => stateAfterCloseTab(prev, tabId, initialTab, firstPinnedKey));
    },
    [state.tabs, storageKey, initialTab, firstPinnedKey],
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

  // No early return when nothing is active: a surface whose only tab was a pinned
  // one the user just closed still has to render its strip, or there is no "+" to
  // open a terminal with.
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
        onReorder={reorder}
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
        ) : activeTab?.kind === "setup" ? (
          (renderSetupLog?.({ workspaceRepoId: activeTab.workspaceRepoId }) ?? null)
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

/** MIME type carrying a dragged tab's id in dataTransfer, namespaced so it
 * won't be picked up as a drop by unrelated drop targets on the page. */
const TAB_DRAG_MIME = "application/x-yarvis-tab";

function TabStrip({
  tabs,
  pinnedTabs,
  activeId,
  onSelect,
  onSelectPinned,
  onClose,
  onClosePinned,
  onNew,
  onReorder,
}: {
  tabs: Tab[];
  pinnedTabs: PinnedTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onSelectPinned: (key: string) => void;
  onClose: (id: string) => void;
  onClosePinned: (pinned: PinnedTab) => void;
  onNew: () => void;
  onReorder: (dragId: string, targetId: string, position: "before" | "after") => void;
}) {
  // The active drag: which tab is being dragged, which tab the cursor is over,
  // and which side of that tab the drop would land on. Bundled so the three
  // fields always clear together on drop / drag end / drag leave.
  const [drag, setDrag] = useState<{
    dragId: string;
    overId: string | null;
    side: "before" | "after";
  } | null>(null);

  const onTabDragStart = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData(TAB_DRAG_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    setDrag({ dragId: id, overId: null, side: "before" });
  };

  const onTabDragOver = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    // Only accept drops carrying our namespaced MIME; ignore drags from other apps.
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Dragging over the source tab itself never renders an indicator; skip the
    // rect math and the state churn dragover would otherwise cause every fire.
    if (drag && drag.dragId === id) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const midpoint = rect.left + rect.width / 2;
    // Drop lands before the target when the cursor is on its left half, after otherwise.
    const side: "before" | "after" = e.clientX < midpoint ? "before" : "after";
    // dragover fires continuously; bail when neither the hovered tab nor the
    // insertion side has changed so we don't re-render on every pointer sample.
    if (drag && drag.overId === id && drag.side === side) return;
    setDrag((prev) => (prev ? { ...prev, overId: id, side } : prev));
  };

  const onTabDrop = (e: React.DragEvent<HTMLDivElement>, id: string) => {
    const from = e.dataTransfer.getData(TAB_DRAG_MIME);
    if (!from) return;
    e.preventDefault();
    // Read side from the drop state, not the previous render's closure — the
    // last dragover before drop set it to the current cursor position.
    const side = drag?.side ?? "before";
    onReorder(from, id, side);
    setDrag(null);
  };

  const onTabDragEnd = () => setDrag(null);
  // Clearing on strip leave prevents a stale indicator from lingering when the
  // cursor exits without dropping (the drag may still be alive over another view).
  const onStripDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDrag((prev) => (prev ? { ...prev, overId: null } : prev));
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragleave clears the drop indicator; keyboard interaction is on inner buttons.
    <div
      onDragLeave={onStripDragLeave}
      className="flex shrink-0 items-center gap-0.5 border-b border-zinc-800 bg-zinc-950 px-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {/* Pinned tabs are externally owned and always lead the strip, so they
            are intentionally not draggable and not drop targets. */}
        {pinnedTabs.map((p) => {
          const active = activeId === pinnedTabId(p.key);
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
          const dragging = drag?.dragId === t.id;
          const isOver = drag?.overId === t.id && drag.dragId !== t.id;
          const showBefore = isOver && drag?.side === "before";
          const showAfter = isOver && drag?.side === "after";
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drag handlers on wrapper; the inner buttons still own click/keyboard activation.
            <div
              key={t.id}
              draggable
              onDragStart={(e) => onTabDragStart(e, t.id)}
              onDragOver={(e) => onTabDragOver(e, t.id)}
              onDrop={(e) => onTabDrop(e, t.id)}
              onDragEnd={onTabDragEnd}
              className={`group relative flex shrink-0 items-center gap-1 border-b-2 px-2 py-1 text-xs ${
                active
                  ? "border-indigo-400 text-zinc-100"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              } ${dragging ? "opacity-50" : ""}`}
            >
              {showBefore && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 -left-0.5 w-0.5 bg-indigo-400"
                />
              )}
              {showAfter && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-y-0 -right-0.5 w-0.5 bg-indigo-400"
                />
              )}
              <button
                type="button"
                onClick={() => onSelect(t.id)}
                className="flex max-w-40 items-center gap-1 truncate"
                title={t.kind === "diff" ? t.path : t.title}
              >
                {t.kind === "diff" && <span className="text-sky-400">±</span>}
                {t.kind === "setup" && <span className="text-red-400">⚠</span>}
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
