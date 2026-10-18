import { subscribe as subscribeAttention } from "../attention/hub.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import type { HeadsDownRun } from "../db/schema.ts";
import { claimJob, finishJob } from "../jobs/store.ts";
import { DEFAULT_HEADS_DOWN_CONFIG, getHeadsDownConfig } from "./config.ts";
import { PASS_TIMEOUT_MS, type PassResult, runPass } from "./pass.ts";
import { getActiveRun } from "./service.ts";
import { setWakeHandler } from "./wake.ts";

/**
 * The heads-down loop: while a run is active, run a pass, sleep for as long as
 * the pass decided, and repeat. Its own worker rather than a scheduled job,
 * because a pass can take many minutes and the job scheduler runs its jobs one
 * after another.
 *
 * A database lease keeps two instances sharing one database from running
 * passes at once. The loop is started only on the instance that runs
 * background workers, like the poller.
 */

/** Held for a pass, longer than one can run, so a crashed pass's lease just expires. */
const LEASE_MS = PASS_TIMEOUT_MS + 5 * 60_000;
const LEASE_NAME = "heads-down";

/** How often the loop looks again when there is no run, or another instance holds the lease. */
export const IDLE_CHECK_MS = 60_000;

/** What the loop runs on, replaceable so a test can drive it without a model or real timers. */
export interface LoopDeps {
  db: Db;
  runPass: (run: HeadsDownRun) => Promise<PassResult>;
  minSleepMs: () => Promise<number>;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

async function minSleepMs(): Promise<number> {
  try {
    return (await getHeadsDownConfig()).minSleepMinutes * 60_000;
  } catch {
    // A settings file that won't parse mustn't stop the loop.
    return DEFAULT_HEADS_DOWN_CONFIG.minSleepMinutes * 60_000;
  }
}

export interface HeadsDownLoop {
  stop: () => void;
  wake: () => void;
  /** Runs one cycle now and resolves when it is done, for tests. */
  cycle: () => Promise<void>;
}

export function createHeadsDownLoop(deps: LoopDeps): HeadsDownLoop {
  const { db } = deps;
  let stopped = false;
  let running = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = deps.setTimer(() => void cycle(), ms);
  };

  const cycle = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      wakeRequested = true;
      return;
    }
    running = true;
    wakeRequested = false;
    let nextMs = IDLE_CHECK_MS;
    try {
      const run = await getActiveRun(db);
      if (run && (await claimJob(db, LEASE_NAME, LEASE_MS))) {
        let status: "ok" | "error" = "ok";
        try {
          nextMs = (await deps.runPass(run)).sleepMinutes * 60_000;
        } catch (e) {
          status = "error";
          console.error("[heads-down] pass failed:", e);
        } finally {
          await finishJob(db, LEASE_NAME, { status });
        }
      }
      // Woken during the pass: something changed that the pass may not have seen.
      if (wakeRequested) nextMs = Math.min(nextMs, await deps.minSleepMs());
    } catch (e) {
      console.error("[heads-down] loop cycle failed:", e);
    } finally {
      running = false;
      schedule(nextMs);
    }
  };

  const wake = () => {
    if (running) wakeRequested = true;
    else schedule(0);
  };

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    wake,
    cycle,
  };
}

export function startHeadsDownLoop(config: Config): () => void {
  if (!config.databaseUrl) return () => {};
  const db = getDb(config.databaseUrl).db;
  const loop = createHeadsDownLoop({
    db,
    runPass: (run) => runPass(config, db, run),
    minSleepMs,
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  setWakeHandler(loop.wake);

  // A workspace session raising attention (waiting on permission, finished)
  // is worth a look, but no more often than the shortest sleep.
  let lastAttentionWake = 0;
  const onAttention = async () => {
    try {
      const now = Date.now();
      if (now - lastAttentionWake < (await minSleepMs())) return;
      lastAttentionWake = now;
      if (await getActiveRun(db)) loop.wake();
    } catch (e) {
      console.error("[heads-down] attention wake failed:", e);
    }
  };
  const unsubscribe = subscribeAttention(() => void onAttention());

  loop.wake();
  return () => {
    loop.stop();
    unsubscribe();
    setWakeHandler(null);
  };
}
