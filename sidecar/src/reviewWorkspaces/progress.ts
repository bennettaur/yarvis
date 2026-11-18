/**
 * Background runs per review PR (clone, refresh, setup) and the progress each
 * one streams, on the shared {@link RunRegistry}: a late viewer gets the recent
 * history replayed, any number can follow, and a slow one never holds up the
 * run. A finished run stays followable for a while so a view opened just after
 * a clone failed can still read why.
 *
 * History is bounded in size, not only in events: log output is coalesced into
 * chunks of at most {@link LOG_CHUNK_CHARS}, so {@link HISTORY_EVENTS} of them
 * hold about a million characters per PR however chatty a setup script is.
 * That is the live tail; the setup log stored on the row is a separate, smaller
 * tail (`SETUP_LOG_CAP`) that outlives the run.
 */

import { RunAlreadyActiveError, RunRegistry } from "../lib/runRegistry.ts";

export type ReviewRunPhase = "clone" | "refresh" | "setup";

export type ReviewProgressEvent =
  | { type: "start"; phase: ReviewRunPhase }
  | { type: "log"; text: string }
  | { type: "done"; phase: ReviewRunPhase; status: string; error: string | null };

const LOG_CHUNK_CHARS = 4096;
const HISTORY_EVENTS = 256;
/** How long log output may sit in the buffer before it is sent anyway. */
const LOG_FLUSH_MS = 100;

const registry = new RunRegistry<ReviewProgressEvent>({
  historyCap: HISTORY_EVENTS,
  followerQueueCap: 1000,
  keepFinishedMs: 10 * 60 * 1000,
  oneRunPerKey: true,
});

/** Resolves when each live run finishes; what `whenIdle` waits on. */
const finished = new Map<string, Promise<void>>();

/** A claimed run: what its producer emits to, and how it ends. */
export interface RunHandle {
  emit(event: ReviewProgressEvent): void;
  /** Flushes any buffered log output and ends the run. */
  finish(): void;
}

/**
 * Claims the run for `key`, or returns null when one is already in flight. The
 * check and the claim are one synchronous step, so of two requests racing for
 * the same PR exactly one gets the handle — which is what lets a caller claim
 * first and only then write the state that says a run is under way.
 */
export function claimRun(key: string): RunHandle | null {
  try {
    registry.start(key);
  } catch (e) {
    if (e instanceof RunAlreadyActiveError) return null;
    throw e;
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  finished.set(key, promise);

  let buffered = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    while (buffered) {
      registry.emit(key, { type: "log", text: buffered.slice(0, LOG_CHUNK_CHARS) });
      buffered = buffered.slice(LOG_CHUNK_CHARS);
    }
  };

  return {
    emit(event) {
      if (event.type !== "log") {
        flush();
        registry.emit(key, event);
        return;
      }
      buffered += event.text;
      if (buffered.length >= LOG_CHUNK_CHARS) flush();
      else timer ??= setTimeout(flush, LOG_FLUSH_MS);
    },
    finish() {
      flush();
      registry.finish(key);
      if (finished.get(key) === promise) finished.delete(key);
      resolve();
    },
  };
}

/**
 * Claims the run for `key` and runs `work` on it in the background. Returns
 * false, starting nothing, when a run is already in flight. `work` reports its
 * own outcome as a `done` event; a throw that escapes it is only logged.
 */
export function startRun(key: string, work: (run: RunHandle) => Promise<void>): boolean {
  const run = claimRun(key);
  if (!run) return false;
  void work(run)
    .catch((e) => console.error(`[review-workspaces] run ${key} failed:`, e))
    .finally(() => run.finish());
  return true;
}

export function isRunning(key: string): boolean {
  return registry.isLive(key);
}

/** Resolves when the run in flight for `key`, if any, has finished. */
export function whenIdle(key: string): Promise<void> {
  return finished.get(key) ?? Promise.resolve();
}

/** Forgets a PR's finished run, once the PR itself is gone. */
export function forgetRuns(key: string): void {
  registry.forget(key);
}

/**
 * Replays the latest run for `key`, then streams the rest of it if it is still
 * going. Resolves at once when there is no run to show. `signal` detaches a
 * viewer whose stream closed, without disturbing the run.
 */
export async function follow(
  key: string,
  emit: (event: ReviewProgressEvent) => unknown,
  signal?: AbortSignal,
): Promise<void> {
  await registry.follow(key, emit, signal);
}
