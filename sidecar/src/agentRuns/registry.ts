import type { AgentRunEvent } from "./events.ts";

/**
 * Agent runs in flight in this process, with what it takes for any number of
 * viewers to follow one: recent history for whoever joins late, and the live
 * events after that. A run is started by a feature's route and finishes whether
 * or not anyone is watching; a viewer closing its stream only stops following.
 */

/**
 * How many events a run keeps for replay, and for the copy stored when it
 * ends. A late viewer gets the tail — enough to see what the run is doing now —
 * rather than a long run's whole transcript.
 */
export const RUN_HISTORY_CAP = 500;

export type AgentRunEmit = (event: AgentRunEvent) => unknown;

interface LiveRun {
  history: AgentRunEvent[];
  subscribers: Set<AgentRunEmit>;
  controller: AbortController;
  finished: Promise<void>;
  markFinished: () => void;
}

export class AgentRunRegistry {
  private readonly runs = new Map<string, LiveRun>();

  /** Registers a run; aborting the returned signal is how it is cancelled. */
  start(id: string): AbortSignal {
    let markFinished = () => {};
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve;
    });
    const controller = new AbortController();
    this.runs.set(id, {
      history: [],
      subscribers: new Set(),
      controller,
      finished,
      markFinished,
    });
    return controller.signal;
  }

  isLive(id: string): boolean {
    return this.runs.has(id);
  }

  /** The run's retained events, oldest first. */
  history(id: string): AgentRunEvent[] {
    return [...(this.runs.get(id)?.history ?? [])];
  }

  /**
   * Records an event and hands it to every viewer. Recording and snapshotting
   * the viewers happen in one synchronous step, which is what lets `follow`
   * join between events without missing one or seeing it twice.
   */
  emit(id: string, event: AgentRunEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    run.history.push(event);
    if (run.history.length > RUN_HISTORY_CAP) run.history.shift();
    for (const subscriber of [...run.subscribers]) subscriber(event);
  }

  /** Ends a run: its followers finish draining and it stops being live. */
  finish(id: string): void {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    run.markFinished();
  }

  /** Asks a live run to stop. False when there is no such run here. */
  cancel(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /**
   * Replays a run's history to `emit`, then streams its events until it ends or
   * `signal` aborts. Resolves false, having sent nothing, when the run isn't
   * live here.
   */
  async follow(id: string, emit: AgentRunEmit, signal?: AbortSignal): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run) return false;
    // Deliveries queue on a chain so the replay stays ahead of live events
    // arriving while it flushes. The chain never rejects and the run never waits
    // on it: a viewer whose stream has closed must not hold up the run.
    let chain: Promise<void> = Promise.resolve();
    const ordered: AgentRunEmit = (event) => {
      chain = chain
        .then(() => emit(event))
        .then(
          () => undefined,
          () => undefined,
        );
    };
    const replay = [...run.history];
    run.subscribers.add(ordered);
    for (const event of replay) ordered(event);
    try {
      await Promise.race([run.finished, aborted(signal)]);
    } finally {
      // Detach before draining: on the abort path everything still queued is
      // headed for a closed stream.
      run.subscribers.delete(ordered);
    }
    await chain;
    return true;
  }
}

/** Resolves when `signal` aborts, or never when there is nothing to wait on. */
function aborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The process's runs; tests build their own registry instead. */
export const agentRunRegistry = new AgentRunRegistry();
