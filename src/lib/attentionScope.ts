import { useSyncExternalStore } from "react";
import type { AttentionItem } from "./attention";

/**
 * What the user is currently looking at, as far as the attention stream cares:
 * the selected workspace and the terminal sessions visible on screen. Views
 * publish into it as they mount and select; the store in `attentionStore.ts`
 * reads it to skip notifying about something already in view, and
 * `useAttentionAutoClear` reads it to clear items the user has effectively seen.
 *
 * A module-level singleton for the same reason `attentionStore` is one: the
 * publishers (a workspace list, each terminal surface) and the consumer (the app
 * shell) sit in unrelated parts of the tree. Like that store and
 * `calendarAlarms.ts`, the window listeners start on the first React subscriber
 * and stop on the last.
 */

export interface ViewedScope {
  /** The workspace on screen, when the workspaces view is showing one. */
  workspaceId: string | null;
  /** PTY ids of the sessions currently rendered, across every mounted surface. */
  sessionKeys: ReadonlySet<string>;
  /** Nothing is "in view" while the window is in the background. */
  focused: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

const windowIsVisible = () => document.hasFocus() && document.visibilityState !== "hidden";

let workspaceId: string | null = null;
// Keyed by surface so each mounted `TerminalTabs` owns (and clears) its own entry.
const sessionsBySurface = new Map<string, string[]>();
let focused = windowIsVisible();

let snapshot: ViewedScope = { workspaceId: null, sessionKeys: EMPTY, focused };
const listeners = new Set<() => void>();

function rebuild(): void {
  const sessionKeys = new Set<string>();
  for (const keys of sessionsBySurface.values()) {
    for (const key of keys) sessionKeys.add(key);
  }
  snapshot = { workspaceId, sessionKeys, focused };
  for (const listener of listeners) listener();
}

/** The workspace the user has open, or null when the view is gone/unselected. */
export function setViewedWorkspace(id: string | null): void {
  if (workspaceId === id) return;
  workspaceId = id;
  rebuild();
}

/**
 * The sessions a terminal surface is showing right now (the active tab's panes).
 * Pass an empty array — or call on unmount — to withdraw the surface's entry.
 */
export function setViewedSessions(surfaceKey: string, keys: string[]): void {
  const prev = sessionsBySurface.get(surfaceKey);
  if (keys.length === 0) {
    if (!prev) return;
    sessionsBySurface.delete(surfaceKey);
  } else {
    if (prev && prev.length === keys.length && prev.every((k, i) => k === keys[i])) return;
    sessionsBySurface.set(surfaceKey, [...keys]);
  }
  rebuild();
}

const onWindowVisibilityChange = () => {
  const next = windowIsVisible();
  if (next === focused) return;
  focused = next;
  rebuild();
};

function startWindowTracking(): void {
  onWindowVisibilityChange();
  window.addEventListener("focus", onWindowVisibilityChange);
  window.addEventListener("blur", onWindowVisibilityChange);
  document.addEventListener("visibilitychange", onWindowVisibilityChange);
}

function stopWindowTracking(): void {
  window.removeEventListener("focus", onWindowVisibilityChange);
  window.removeEventListener("blur", onWindowVisibilityChange);
  document.removeEventListener("visibilitychange", onWindowVisibilityChange);
}

/**
 * Whether an item's origin is on screen. An item that names a session is judged
 * *only* by that session: it is the tab that wants the user, and being in the
 * workspace it belongs to doesn't mean the user has seen it — that is what lets
 * the tab strip flag it while another of the workspace's tabs is open. Items
 * with no session fall back to their workspace. Pure so the matching rules are
 * testable without a DOM.
 */
export function isInView(scope: ViewedScope, item: AttentionItem): boolean {
  if (!scope.focused) return false;
  if (item.sessionKey) return scope.sessionKeys.has(item.sessionKey);
  return Boolean(item.workspaceId) && item.workspaceId === scope.workspaceId;
}

export function getViewedScope(): ViewedScope {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) startWindowTracking();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWindowTracking();
  };
}

export function useViewedScope(): ViewedScope {
  return useSyncExternalStore(subscribe, getViewedScope);
}
