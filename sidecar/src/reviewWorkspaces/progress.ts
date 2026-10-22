/**
 * Background runs per review PR (clone, refresh, setup) and the progress each
 * one streams. Shaped like workspace provisioning's run registry
 * (`workspaces/service.ts`): a run records recent events for replay and fans
 * them out to every subscriber, so the review view can close and reopen during
 * a clone and pick the log back up instead of losing it.
 *
 * Unlike provisioning, a finished run's history is kept until the next run for
 * that PR starts, so a view opened just after a clone failed can still read
 * why. That is bounded by {@link HISTORY_CAP} per PR and dropped with the PR.
 */

export type ReviewRunPhase = "clone" | "refresh" | "setup";

export type ReviewProgressEvent =
  | { type: "start"; phase: ReviewRunPhase }
  | { type: "log"; text: string }
  | { type: "done"; phase: ReviewRunPhase; status: string; error: string | null };

export type ReviewProgressEmit = (event: ReviewProgressEvent) => void | Promise<void>;

/** Enough tail to see what is happening now without holding a whole build log. */
const HISTORY_CAP = 500;

interface Run {
  history: ReviewProgressEvent[];
  subscribers: Set<ReviewProgressEmit>;
  finished: Promise<void>;
  running: boolean;
}

const runs = new Map<string, Run>();

/** Whether a run for `key` is in flight. */
export function isRunning(key: string): boolean {
  return runs.get(key)?.running ?? false;
}

/** Resolves when the run in flight for `key` (if any) has finished. */
export function whenIdle(key: string): Promise<void> {
  const run = runs.get(key);
  return run?.running ? run.finished : Promise.resolve();
}

/** Forgets a PR's last run, once the PR itself is gone. */
export function forgetRuns(key: string): void {
  if (!isRunning(key)) runs.delete(key);
}

/**
 * Starts `work` as the run for `key` unless one is already in flight, in which
 * case it returns false and nothing starts. The check and the claim are one
 * synchronous step, so two requests can't both start a run.
 *
 * `work` gets an `emit` that records and fans out in order; it is never
 * rejected by a subscriber's failure. Whatever `work` throws is the caller's to
 * have turned into a `done` event first — the run just ends.
 */
export function startRun(key: string, work: (emit: ReviewProgressEmit) => Promise<void>): boolean {
  if (isRunning(key)) return false;
  const { promise: finished, resolve } = Promise.withResolvers<void>();
  const run: Run = { history: [], subscribers: new Set(), finished, running: true };
  runs.set(key, run);

  let chain: Promise<void> = Promise.resolve();
  const emit: ReviewProgressEmit = (event) => {
    chain = chain.then(async () => {
      // Recording and snapshotting the subscribers stay one synchronous step,
      // so a subscriber joining meanwhile neither misses this event nor gets it
      // twice (see `follow`).
      run.history.push(event);
      if (run.history.length > HISTORY_CAP) run.history.shift();
      const subscribers = [...run.subscribers];
      await Promise.all(
        subscribers.map((subscriber) =>
          Promise.resolve()
            .then(() => subscriber(event))
            .catch(() => undefined),
        ),
      );
    });
    return chain;
  };

  void (async () => {
    try {
      await work(emit);
    } catch (e) {
      console.error(`[review-workspaces] run ${key} failed:`, e);
    } finally {
      await chain;
      run.running = false;
      resolve();
    }
  })();
  return true;
}

/**
 * Replays the latest run for `key`, then streams the rest of it if it is still
 * going. Resolves at once when there has been no run. `signal` detaches a
 * follower whose stream closed without disturbing the run.
 */
export async function follow(
  key: string,
  emit: ReviewProgressEmit,
  signal?: AbortSignal,
): Promise<void> {
  const run = runs.get(key);
  if (!run) return;
  let chain: Promise<void> = Promise.resolve();
  const ordered: ReviewProgressEmit = (event) => {
    chain = chain.then(() => emit(event)).catch(() => undefined);
  };
  const replay = [...run.history];
  const live = run.running;
  if (live) run.subscribers.add(ordered);
  for (const event of replay) ordered(event);
  if (live) {
    try {
      await Promise.race([run.finished, aborted(signal)]);
    } finally {
      run.subscribers.delete(ordered);
    }
  }
  await chain;
}

function aborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
