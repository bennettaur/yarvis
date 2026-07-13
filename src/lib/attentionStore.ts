import { useSyncExternalStore } from "react";
import {
  type AttentionItem,
  type AttentionStatus,
  getAttention,
  patchAttention,
  streamAttention,
} from "./attention";
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

/** Replaces the snapshot wholesale (hydrate / re-hydrate on reconnect). */
function hydrateFrom(items: AttentionItem[]): void {
  snapshot = [...items].sort(bySeqDesc);
  emit();
}

/** Applies one streamed item to the live snapshot, notifying on genuinely-new items. */
function applyItem(item: AttentionItem): void {
  const { list, added, changed } = applyAttentionItem(snapshot, item);
  if (!changed) return;
  snapshot = list;
  emit();
  if (added && primed) {
    void notify(item.title, item.body ?? "Wants your attention");
  }
}

async function hydrate(): Promise<void> {
  try {
    hydrateFrom(await getAttention("pending"));
  } catch {
    // Sidecar not ready yet; the stream loop re-hydrates on the next attempt.
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
      } catch {
        // Stream dropped (sidecar restart, network blip) — fall through to reconnect.
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
  } catch {
    // The item stays gone locally; a re-hydrate will restore it if it's still pending.
  }
}
