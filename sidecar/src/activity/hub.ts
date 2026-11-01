import { redactSecrets } from "../llm/errors.ts";

/**
 * Live agent activity for the Agent Field page: what Claude Code sessions and
 * Yarvis's own agents are doing, as it happens. Process-local and never
 * stored, like the attention hub — an event nobody is watching is simply
 * dropped, since the page only draws the present.
 */

/** Which kind of agent did it; the page draws each with its own sprite. */
export type ActivityOrigin = "claude" | "yarvis";

/** The event kinds the Agent Field page draws and scores. */
export type ActivityType =
  | "prompt"
  | "tool"
  | "read"
  | "edit"
  | "bash"
  | "search"
  | "spawn"
  | "subagent_done"
  | "done"
  | "error"
  | "notify";

export interface ActivityEvent {
  origin: ActivityOrigin;
  type: ActivityType;
  /** The agent it came from; the page gives each source its own orbiting node. */
  source: string;
  /** A short description for the page's log, e.g. a tool name and its target. */
  label: string;
}

/** Longest label the page's log shows; anything longer is cut. */
const MAX_LABEL = 64;

/** One line, secret-shaped values masked, and short enough for the log. */
export function clipLabel(text: string): string {
  const line = redactSecrets(text).replace(/\s+/g, " ").trim();
  return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}…` : line;
}

type Listener = (event: ActivityEvent) => void;

const listeners = new Set<Listener>();

/** Fan an event out to every open stream. Never throws to the caller. */
export function publishActivity(event: ActivityEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("[activity] stream listener failed:", e instanceof Error ? e.message : e);
    }
  }
}

/** Register a listener; returns an unsubscribe to call when the stream closes. */
export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True while any page is watching. Publishers check it before building an
 * event, so activity costs nothing while the page is closed.
 */
export function hasActivitySubscribers(): boolean {
  return listeners.size > 0;
}

/** Reports a step of Yarvis's own work, at no cost while nobody is watching. */
export function reportYarvisActivity(source: string, type: ActivityType, label: string): void {
  if (!hasActivitySubscribers()) return;
  publishActivity({ origin: "yarvis", type, source: clipLabel(source), label: clipLabel(label) });
}
