import { type AgentRunEvent, streamAgentRun } from "./agentRuns";

/**
 * One stream per run, shared by every view following it. The webview allows
 * only a few open connections to the sidecar, so the PR nav and a run's tab
 * mustn't each hold their own.
 */

export interface RunFollower {
  onEvent?: (event: AgentRunEvent) => void;
  /** The stream ended: after the run's `done`, or with the error that lost it. */
  onEnd: (error: unknown) => void;
}

interface SharedStream {
  /** Every event so far, replayed to a follower that joins late. */
  events: AgentRunEvent[];
  followers: Set<RunFollower>;
  abort: AbortController;
}

const streams = new Map<string, SharedStream>();

/**
 * Follows run `id` from its first event, joining the open stream when there is
 * one. Returns the call that stops following; the stream closes with its last
 * follower.
 */
export function followAgentRun(id: string, follower: RunFollower): () => void {
  const shared = streams.get(id) ?? open(id);
  for (const event of shared.events) follower.onEvent?.(event);
  shared.followers.add(follower);
  return () => {
    shared.followers.delete(follower);
    if (shared.followers.size > 0) return;
    shared.abort.abort();
    if (streams.get(id) === shared) streams.delete(id);
  };
}

function open(id: string): SharedStream {
  const shared: SharedStream = { events: [], followers: new Set(), abort: new AbortController() };
  streams.set(id, shared);
  void (async () => {
    let error: unknown = null;
    try {
      for await (const event of streamAgentRun(id, shared.abort.signal)) {
        shared.events.push(event);
        notify(shared, (f) => f.onEvent?.(event));
      }
    } catch (e) {
      error = e;
    }
    // Removed first, so a follower that re-follows from onEnd gets a fresh stream.
    if (streams.get(id) === shared) streams.delete(id);
    if (shared.abort.signal.aborted) return;
    notify(shared, (f) => f.onEnd(error));
  })();
  return shared;
}

/** Calls each current follower, so one view's bug can't end the stream for the others. */
function notify(shared: SharedStream, call: (follower: RunFollower) => void): void {
  for (const f of [...shared.followers]) {
    // A follower an earlier call unsubscribed has stopped listening.
    if (!shared.followers.has(f)) continue;
    try {
      call(f);
    } catch (e) {
      console.error("[agent-runs] a run follower threw:", e);
    }
  }
}
