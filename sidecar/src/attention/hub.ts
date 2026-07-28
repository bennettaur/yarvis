import type { AttentionItemRow } from "../db/schema.ts";

/**
 * A tiny in-process broadcaster for attention items. The ingest and patch routes
 * `publish` a row after persisting it; each open SSE stream (`/api/attention/stream`)
 * `subscribe`s and forwards rows to its client. Kept attention-scoped for now;
 * straightforward to generalize into a shared push bus later.
 *
 * This is process-local, which is correct for this single-process sidecar — every
 * client connects to the same instance. It is intentionally *not* the durable
 * record: the database is. A client that misses a live event while disconnected
 * recovers by re-hydrating from `listAttention` on reconnect.
 */

/** A live delta on the attention stream. `ping` is a keep-alive, emitted by the stream loop. */
export type AttentionStreamEvent = { type: "item"; item: AttentionItemRow } | { type: "ping" };

type Listener = (item: AttentionItemRow) => void;

const listeners = new Set<Listener>();

/** Fan a persisted item out to every open stream. Never throws to the caller. */
export function publish(item: AttentionItemRow): void {
  for (const listener of listeners) {
    try {
      listener(item);
    } catch (e) {
      console.error("[attention] stream listener failed:", e instanceof Error ? e.message : e);
    }
  }
}

/** Register a listener; returns an unsubscribe to call when the stream closes. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/introspection helper: how many streams are currently subscribed. */
export function subscriberCount(): number {
  return listeners.size;
}
