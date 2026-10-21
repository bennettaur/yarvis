import type { AgentEvent } from "../chat/agent.ts";

/**
 * Live updates from heads-down mode for the Heads down page: what a pass is
 * doing as it does it, and when something changes that the page shows.
 * Process-local, like the attention hub; the database holds the record, and a
 * page that missed an update re-reads it.
 */
export type HeadsDownStreamEvent =
  | { type: "pass-started"; passId: string }
  | { type: "pass-event"; passId: string; event: AgentEvent }
  | { type: "pass-finished"; passId: string; sleepMinutes: number; nextPassAt: string }
  /** A question or answer, a message, or the run starting or stopping. */
  | { type: "changed" }
  | { type: "ping" };

type Listener = (event: HeadsDownStreamEvent) => void;

const listeners = new Set<Listener>();

/** Fans an event out to every open stream. Never throws to the caller. */
export function publish(event: HeadsDownStreamEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("[heads-down] stream listener failed:", e instanceof Error ? e.message : e);
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
