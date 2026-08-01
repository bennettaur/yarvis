import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  type AttentionItem,
  type AttentionScope,
  type AttentionStatus,
  clearAttention,
  getAttention,
  patchAttention,
  streamAttention,
} from "./attention";
import { type AttentionGroup, groupAttentionItems } from "./attentionGroups";
import { getViewedScope, isInView, useViewedScope, type ViewedScope } from "./attentionScope";
import { notify } from "./notify";

/**
 * A shared, app-wide store of the *pending* attention items — the things asking
 * for the user right now. It hydrates once, then stays live over the sidecar's
 * SSE stream, so the persistent indicator and the slide-out panel read the same
 * snapshot without prop-drilling. Modeled on `calendarAlarms.ts`: the connection
 * starts on the first React subscriber and stops on the last.
 *
 * Only pending items live here; reading, resolving, or dismissing an item drops
 * it from the snapshot (its history is still recorded server-side).
 */

let snapshot: AttentionItem[] = [];
const listeners = new Set<() => void>();

/** Backoff before reopening the stream after it ends or errors. */
const RECONNECT_MS = 2_000;

let controller: AbortController | null = null;
let running = false;
// Suppresses notifications for the items present at hydrate — opening the app
// shouldn't replay a backlog as fresh alerts.
let primed = false;

function emit(): void {
  for (const listener of listeners) listener();
}

const bySeqDesc = (a: AttentionItem, b: AttentionItem) => b.seq - a.seq;

export interface AttentionApplyResult {
  list: AttentionItem[];
  /** True when a pending item not previously in the list was added (drives notify). */
  added: boolean;
  /** True when the list actually changed (drives re-render). */
  changed: boolean;
}

/**
 * Pure reducer for one item: a pending item is upserted by id (newest-first by
 * `seq`); any other status removes it. Extracted so the merge is unit-testable
 * without an SSE/DOM harness.
 */
export function applyAttentionItem(
  list: AttentionItem[],
  item: AttentionItem,
): AttentionApplyResult {
  if (item.status !== "pending") {
    const next = list.filter((i) => i.id !== item.id);
    return { list: next, added: false, changed: next.length !== list.length };
  }
  const existing = list.some((i) => i.id === item.id);
  const next = (existing ? list.map((i) => (i.id === item.id ? item : i)) : [item, ...list]).sort(
    bySeqDesc,
  );
  return { list: next, added: !existing, changed: true };
}

/**
 * Ids that arrived via a hydrate rather than the live stream — a backlog raised
 * while the app was closed or disconnected. Auto-clear skips these: the user
 * wasn't there when they were raised, so having the workspace on screen at
 * launch is no evidence they were seen. They clear on an explicit open/dismiss.
 */
const backlog = new Set<string>();

/** Whether an item arrived as backlog rather than live. Exposed for the auto-clear pass. */
function isBacklogged(id: string): boolean {
  return backlog.has(id);
}

/** Replaces the snapshot wholesale (hydrate / re-hydrate on reconnect). */
function hydrateFrom(items: AttentionItem[]): void {
  snapshot = [...items].sort(bySeqDesc);
  backlog.clear();
  for (const item of items) backlog.add(item.id);
  emit();
}

/**
 * Applies one streamed item to the live snapshot, notifying on genuinely-new
 * items. An item whose origin is already on screen doesn't notify — the user is
 * looking straight at it, and the auto-clear pass is about to drop it anyway.
 */
function applyItem(item: AttentionItem): void {
  const { list, added, changed } = applyAttentionItem(snapshot, item);
  if (!changed) return;
  snapshot = list;
  // Streamed while the app was watching, so it is no longer backlog.
  backlog.delete(item.id);
  emit();
  if (added && primed && !isInView(getViewedScope(), item)) {
    void notify(item.title, item.body ?? "Wants your attention");
  }
}

async function hydrate(): Promise<void> {
  try {
    hydrateFrom(await getAttention("pending"));
  } catch (e) {
    // Sidecar not ready yet; the stream loop re-hydrates on the next attempt.
    console.warn("[attention] hydrate failed (will retry):", e);
  }
}

/** Runs the hydrate + live-stream loop until the last subscriber leaves. */
function start(): void {
  if (running) return;
  running = true;
  controller = new AbortController();
  const signal = controller.signal;

  void (async () => {
    await hydrate();
    primed = true;
    while (!signal.aborted) {
      try {
        for await (const event of streamAttention(signal)) {
          if (event.type === "item") applyItem(event.item);
        }
      } catch (e) {
        // Stream dropped (sidecar restart, network blip) — fall through to reconnect.
        if (!signal.aborted) console.warn("[attention] stream dropped, reconnecting:", e);
      }
      if (signal.aborted) break;
      // Re-hydrate on reconnect so anything missed while disconnected reappears.
      await hydrate();
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();
}

function stop(): void {
  running = false;
  primed = false;
  controller?.abort();
  controller = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/** The live list of pending attention items, newest-first. */
export function useAttentionItems(): AttentionItem[] {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * The pending stream folded to one entry per origin. Shared so the bell badge
 * and the panel it opens can't disagree about how many things are waiting.
 */
export function useAttentionGroups(): AttentionGroup[] {
  const items = useAttentionItems();
  return useMemo(() => groupAttentionItems(items), [items]);
}

/**
 * Workspace ids with something pending, for highlighting them in a list while
 * the user is looking at a different one.
 */
export function useAttentionWorkspaceIds(): ReadonlySet<string> {
  const items = useAttentionItems();
  return useMemo(
    () => new Set(items.map((i) => i.workspaceId).filter((id): id is string => Boolean(id))),
    [items],
  );
}

/** PTY session ids with something pending, for highlighting the tabs behind them. */
export function useAttentionSessionKeys(): ReadonlySet<string> {
  const items = useAttentionItems();
  return useMemo(
    () => new Set(items.map((i) => i.sessionKey).filter((key): key is string => Boolean(key))),
    [items],
  );
}

/**
 * Marks an item and optimistically drops it from the snapshot so the UI reacts
 * immediately; the server broadcast confirms it. Best-effort on failure.
 */
export async function markAttention(
  id: string,
  status: Exclude<AttentionStatus, "pending">,
): Promise<void> {
  const next = snapshot.filter((i) => i.id !== id);
  if (next.length !== snapshot.length) {
    snapshot = next;
    emit();
  }
  try {
    await patchAttention(id, status);
  } catch (e) {
    // The item stays gone locally; a re-hydrate will restore it if it's still pending.
    console.error(`[attention] failed to mark ${id} as ${status}:`, e);
  }
}

/**
 * Marks every pending item in a scope — a whole workspace, or one terminal
 * session — in a single request. Optimistic like `markAttention`.
 */
export async function markAttentionScope(
  scope: AttentionScope,
  status: Exclude<AttentionStatus, "pending">,
): Promise<void> {
  const next = snapshot.filter(
    (i) =>
      !(scope.workspaceId && i.workspaceId === scope.workspaceId) &&
      !(scope.sessionKey && i.sessionKey === scope.sessionKey),
  );
  if (next.length !== snapshot.length) {
    snapshot = next;
    emit();
  }
  try {
    await clearAttention(scope, status);
  } catch (e) {
    console.error("[attention] failed to clear scope:", scope, e);
  }
}

/** What one auto-clear pass should mark read. */
export interface ClearTargets {
  /** One request per session, however many of its items are pending. */
  sessionKeys: string[];
  /**
   * Items with no session, cleared individually. A workspace scope would be the
   * cheaper request, but the server reads it as "everything this workspace
   * raised" — including sessions whose tabs are *not* on screen, which is
   * exactly what the session-precise rule exists to avoid.
   */
  itemIds: string[];
}

/**
 * What to clear given a snapshot and what's on screen, deduplicated so a session
 * with several pending items costs one request. Covers only items `isInView`
 * accepts — which is what keeps the auto-clear loop converging — and skips
 * backlog. Pure so those rules are testable without an SSE/DOM harness.
 */
export function clearTargetsFor(
  items: AttentionItem[],
  scope: ViewedScope,
  isBacklogged: (id: string) => boolean = () => false,
): ClearTargets {
  const sessionKeys = new Set<string>();
  const itemIds: string[] = [];
  for (const item of items) {
    if (isBacklogged(item.id) || !isInView(scope, item)) continue;
    if (item.sessionKey) sessionKeys.add(item.sessionKey);
    else itemIds.push(item.id);
  }
  return { sessionKeys: [...sessionKeys], itemIds };
}

/**
 * Clears items whose origin the user is looking at — the point of the whole
 * scope machinery: opening the tab (or the workspace) that raised a flag counts
 * as having seen it, so it shouldn't need dismissing by hand. Mounted once, in
 * the app shell.
 */
export function useAttentionAutoClear(): void {
  const items = useAttentionItems();
  const scope = useViewedScope();

  useEffect(() => {
    const { sessionKeys, itemIds } = clearTargetsFor(items, scope, isBacklogged);
    for (const sessionKey of sessionKeys) void markAttentionScope({ sessionKey }, "read");
    for (const id of itemIds) void markAttention(id, "read");
  }, [items, scope]);
}
