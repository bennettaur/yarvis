/**
 * Background runs in flight in this process, with what it takes for any number
 * of viewers to follow one: recent history for whoever joins late, then the live
 * events after that. A run finishes whether or not anyone is watching; a viewer
 * closing its stream only stops following.
 */

export interface RunRegistryOptions {
  /**
   * How many events a run keeps for replay. A late viewer gets the tail —
   * enough to see what the run is doing now — rather than a long run's whole
   * transcript.
   */
  historyCap: number;
  /**
   * How many undelivered events one viewer may fall behind by before it is
   * dropped. A viewer whose stream stalled would otherwise queue every event
   * for the rest of the run.
   */
  followerQueueCap: number;
  /**
   * How long a finished run stays followable (its history replayed, then the
   * stream ends) for callers with nowhere else to read a finished run from.
   * Zero forgets it at once.
   */
  keepFinishedMs?: number;
  /** Refuse to start a run under a key that already has one in flight. */
  oneRunPerKey?: boolean;
}

export type RunEmit<E> = (event: E) => unknown;

export class RunAlreadyActiveError extends Error {
  constructor(key: string) {
    super(`a run is already in progress for ${key}`);
  }
}

interface Follower<E> {
  deliver: RunEmit<E>;
  pending: number;
  dropped: () => void;
}

interface Run<E> {
  history: E[];
  followers: Set<Follower<E>>;
  controller: AbortController;
  live: boolean;
  finished: Promise<void>;
  markFinished: () => void;
  forgetTimer?: ReturnType<typeof setTimeout>;
}

export class RunRegistry<E> {
  private readonly runs = new Map<string, Run<E>>();

  constructor(private readonly options: RunRegistryOptions) {}

  /** Registers a run under `key`; aborting the returned signal is how it is cancelled. */
  start(key: string): AbortSignal {
    const existing = this.runs.get(key);
    if (existing?.live && this.options.oneRunPerKey) throw new RunAlreadyActiveError(key);
    if (existing?.forgetTimer) clearTimeout(existing.forgetTimer);
    let markFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const controller = new AbortController();
    this.runs.set(key, {
      history: [],
      followers: new Set(),
      controller,
      live: true,
      finished,
      markFinished,
    });
    return controller.signal;
  }

  isLive(key: string): boolean {
    return this.runs.get(key)?.live === true;
  }

  /** Every key with a run in flight. */
  liveKeys(): string[] {
    return [...this.runs].filter(([, run]) => run.live).map(([key]) => key);
  }

  /** The run's retained events, oldest first. */
  history(key: string): E[] {
    return [...(this.runs.get(key)?.history ?? [])];
  }

  /**
   * Records an event and hands it to every viewer. Recording and snapshotting
   * the viewers happen in one synchronous step, which is what lets `follow`
   * join between events without missing one or seeing it twice.
   */
  emit(key: string, event: E): void {
    const run = this.runs.get(key);
    if (!run?.live) return;
    run.history.push(event);
    if (run.history.length > this.options.historyCap) run.history.shift();
    for (const follower of [...run.followers]) {
      if (follower.pending >= this.options.followerQueueCap) {
        run.followers.delete(follower);
        follower.dropped();
        continue;
      }
      follower.deliver(event);
    }
  }

  /** Ends a run: its followers finish draining and it stops being live. */
  finish(key: string): void {
    const run = this.runs.get(key);
    if (!run?.live) return;
    run.live = false;
    run.markFinished();
    const keepMs = this.options.keepFinishedMs ?? 0;
    if (keepMs <= 0) {
      this.runs.delete(key);
      return;
    }
    run.forgetTimer = setTimeout(() => {
      if (this.runs.get(key) === run) this.runs.delete(key);
    }, keepMs);
    run.forgetTimer.unref?.();
  }

  /** Drops a finished run's history now, rather than when `keepFinishedMs` runs out. */
  forget(key: string): void {
    const run = this.runs.get(key);
    if (!run || run.live) return;
    if (run.forgetTimer) clearTimeout(run.forgetTimer);
    this.runs.delete(key);
  }

  /** Asks a live run to stop. False when there is no such run here. */
  cancel(key: string): boolean {
    const run = this.runs.get(key);
    if (!run?.live) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Replays a run's history to `emit`, then streams its events until it ends,
   * `signal` aborts, or the viewer falls too far behind. Resolves false, having
   * sent nothing, when there is no such run here.
   */
  async follow(key: string, emit: RunEmit<E>, signal?: AbortSignal): Promise<boolean> {
    const run = this.runs.get(key);
    if (!run) return false;
    // Deliveries queue on a chain so the replay stays ahead of live events
    // arriving while it flushes. The chain never rejects and the run never waits
    // on it: a viewer whose stream has closed must not hold up the run.
    let chain: Promise<void> = Promise.resolve();
    let markDropped = () => {};
    const dropped = new Promise<void>((resolve) => {
      markDropped = resolve;
    });
    const follower: Follower<E> = {
      pending: 0,
      dropped: markDropped,
      deliver: (event) => {
        follower.pending++;
        chain = chain
          .then(() => emit(event))
          .then(
            () => undefined,
            () => undefined,
          )
          .finally(() => {
            follower.pending--;
          });
      },
    };
    const replay = [...run.history];
    if (run.live) run.followers.add(follower);
    for (const event of replay) follower.deliver(event);
    try {
      if (run.live) await Promise.race([run.finished, dropped, whenAborted(signal)]);
    } finally {
      // Detach before draining: on the abort path everything still queued is
      // headed for a closed stream.
      run.followers.delete(follower);
    }
    await chain;
    return true;
  }
}

/** Resolves when `signal` aborts, or never when there is nothing to wait on. */
function whenAborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
