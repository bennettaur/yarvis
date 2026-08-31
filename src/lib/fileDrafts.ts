import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Unsaved editor buffers, held app-wide rather than inside the editor
 * component.
 *
 * A terminal surface only mounts its active tab, so an editor tab loses its
 * component the moment the user switches to another tab — and typed-but-unsaved
 * text with it. Keeping the buffer here is what lets a tab switch, or a trip out
 * to another view, come back to what was being written. A draft exists only
 * while it differs from what is on disk, so "has a draft" and "is dirty" are the
 * same question.
 *
 * Memory only: these are file contents, which have no business in localStorage's
 * few megabytes, and a draft that outlived a restart would be a change the user
 * can no longer see the source of.
 */

export interface FileDraft {
  text: string;
  /**
   * Hash of the file as it was when this edit started.
   *
   * Held with the buffer rather than read off whatever the editor last loaded:
   * the buffer outlives the component, so a tab closed and reopened re-reads the
   * file and would otherwise adopt the *current* hash as its base. A save then
   * carries a hash that matches disk, is accepted, and silently replaces
   * whatever wrote in between — which is the one thing the hash is there to
   * prevent.
   */
  baseHash: string;
}

/** NUL, because it is the one character neither an id nor a path can hold, so
 *  no pair of parts can spell out another pair's key. */
const SEPARATOR = "\u0000";

/** Identifies one file within a workspace — and, unchanged, is how a terminal
 *  surface names the editor tab showing it (`editorTabKey`). */
export const fileKey = (repoId: string, path: string): string => `${repoId}${SEPARATOR}${path}`;

/** Identifies one file's buffer. Composed from `fileKey` so the half of the key
 *  the tab strip matches on cannot drift from what this produces. */
export const draftKey = (workspaceId: string, repoId: string, path: string): string =>
  `${workspaceId}${SEPARATOR}${fileKey(repoId, path)}`;

let drafts: ReadonlyMap<string, FileDraft> = new Map();
/**
 * Which files have a buffer, rebuilt only when one appears or disappears.
 *
 * Typing replaces `drafts` on every keystroke, so anything subscribed to the map
 * re-renders per character. The tab strip only needs to know *which* files are
 * dirty — a set that changes on the first keystroke and on save, not in between
 * — so it is held separately and its identity left alone.
 */
let dirtyKeys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getDraft(key: string): FileDraft | null {
  return drafts.get(key) ?? null;
}

export function setDraft(key: string, draft: FileDraft): void {
  const appeared = !drafts.has(key);
  const next = new Map(drafts);
  next.set(key, draft);
  drafts = next;
  if (appeared) dirtyKeys = new Set(next.keys());
  emit();
}

export function clearDraft(key: string): void {
  if (!drafts.has(key)) return;
  const next = new Map(drafts);
  next.delete(key);
  drafts = next;
  dirtyKeys = new Set(next.keys());
  emit();
}

/** One file's unsaved buffer, or null when it matches what is on disk. */
export function useDraft(key: string): FileDraft | null {
  const read = useCallback(() => drafts.get(key) ?? null, [key]);
  return useSyncExternalStore(subscribe, read);
}

/**
 * The `fileKey` of every dirty file in one workspace — the same key a terminal
 * surface names its editor tabs with, which is what lets the tab strip mark a
 * tab whose editor isn't mounted.
 */
export function useWorkspaceDraftKeys(workspaceId: string): ReadonlySet<string> {
  const keys = useSyncExternalStore(subscribe, () => dirtyKeys);
  return useMemo(() => {
    const prefix = `${workspaceId}${SEPARATOR}`;
    const mine = new Set<string>();
    for (const key of keys) {
      if (key.startsWith(prefix)) mine.add(key.slice(prefix.length));
    }
    return mine;
  }, [keys, workspaceId]);
}

/** Drops every buffer. For tests — the app has no "discard everything" action. */
export function resetDrafts(): void {
  drafts = new Map();
  dirtyKeys = new Set();
  emit();
}
