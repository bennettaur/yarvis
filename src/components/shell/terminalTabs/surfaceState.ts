import { leaf, type Pane, type PaneId } from "./paneTree";

/**
 * The persisted shape of one terminal surface, and the rules for what it holds
 * when it has no tabs of its own. Split out from `TerminalTabs` — like
 * `paneTree` and `reorderTabs` — so the decisions can be exercised without
 * mounting a surface full of live shells.
 */

/** A normal tab: a splittable tree of terminal panes. */
export interface TerminalTab {
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
export interface DiffTab {
  id: string;
  title: string;
  kind: "diff";
  repoId: string;
  path: string;
}

/**
 * A tab showing a workspace repo's setup-script output (and any provisioning
 * error) after a failed provision. Like a diff tab it owns no PTY and only
 * tracks which repo it shows; the surface's owner renders the body via
 * `renderSetupLog`. Tracking the repo here lets a repeat request re-select the
 * existing tab instead of opening a second one.
 */
export interface SetupLogTab {
  id: string;
  title: string;
  kind: "setup";
  workspaceRepoId: string;
}

export type Tab = TerminalTab | DiffTab | SetupLogTab;

/**
 * A tab bound to an externally-managed PTY session (e.g. an agent session the
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

export interface SurfaceState {
  tabs: Tab[];
  activeTabId: string;
  /** Last focused pane per tab — lets a tab switch restore the pane the user was in. */
  focused: Record<string, PaneId>;
}

/**
 * What a surface holds when it has no tabs of its own — on first open, and after
 * the last one is closed. `"terminal"` always keeps one shell open, which is what
 * a standalone terminal surface wants; `"none"` lets the surface sit empty, for
 * one whose owner supplies the tab that matters.
 */
export type InitialTab = "terminal" | "none";

/** activeTabId value marking a pinned tab as selected. */
const PINNED_PREFIX = "pinned:";
export const pinnedTabId = (key: string) => `${PINNED_PREFIX}${key}`;
export const isPinnedTabId = (id: string) => id.startsWith(PINNED_PREFIX);
export const pinnedKeyOf = (id: string) => id.slice(PINNED_PREFIX.length);

let uidCounter = 0;
export const uid = (kind: "t" | "p") =>
  `${kind}${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

export function freshState(): SurfaceState {
  const paneId = uid("p");
  const tabId = uid("t");
  return {
    tabs: [{ id: tabId, title: "Terminal", kind: "terminal", root: leaf(paneId) }],
    activeTabId: tabId,
    focused: { [tabId]: paneId },
  };
}

/** A surface with no tabs of its own, so opening one doesn't spawn a shell the
 *  user never asked for and then has to close. */
export function emptyState(): SurfaceState {
  return { tabs: [], activeTabId: "", focused: {} };
}

export function defaultState(initialTab: InitialTab): SurfaceState {
  return initialTab === "none" ? emptyState() : freshState();
}

export function storageKeyFor(key: string) {
  return `yarvis.terminalTabs.${key}`;
}

export function loadState(key: string, initialTab: InitialTab): SurfaceState {
  try {
    const raw = localStorage.getItem(storageKeyFor(key));
    if (!raw) return defaultState(initialTab);
    const parsed = JSON.parse(raw) as SurfaceState;
    if (!parsed.tabs?.length) return defaultState(initialTab);
    // Backfill `kind` for states persisted before diff tabs existed: a tab with a
    // pane tree is a terminal tab.
    parsed.tabs = parsed.tabs.map((t) =>
      (t as Tab).kind ? t : ({ ...t, kind: "terminal" } as TerminalTab),
    );
    return parsed;
  } catch {
    return defaultState(initialTab);
  }
}

/**
 * The state after a tab is removed. Closing the last one is the interesting
 * case: a surface that owns no default tab may sit empty — its pinned tab is the
 * point, and respawning a shell there is exactly the tab the user was trying to
 * get rid of — while anywhere else reopens one, so the surface is never left with
 * nothing to show. `fallbackPinnedKey` is what to select in that empty case, or
 * `null` to leave nothing selected. The caller kills the tab's sessions; this
 * only moves state.
 */
export function stateAfterCloseTab(
  prev: SurfaceState,
  tabId: string,
  initialTab: InitialTab,
  fallbackPinnedKey: string | null,
): SurfaceState {
  const remaining = prev.tabs.filter((t) => t.id !== tabId);
  const { [tabId]: _omit, ...focused } = prev.focused;
  if (remaining.length === 0) {
    if (initialTab !== "none") return freshState();
    return {
      tabs: [],
      activeTabId: fallbackPinnedKey ? pinnedTabId(fallbackPinnedKey) : "",
      focused: {},
    };
  }
  const activeTabId = prev.activeTabId === tabId ? (remaining[0]?.id ?? "") : prev.activeTabId;
  return { tabs: remaining, activeTabId, focused };
}
