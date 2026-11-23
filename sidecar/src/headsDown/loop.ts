import { subscribe as subscribeAttention } from "../attention/hub.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import type { AttentionItemRow, HeadsDownRun } from "../db/schema.ts";
import { claimJob, finishJob } from "../jobs/store.ts";
import { listPendingWakes } from "../scheduledTasks/service.ts";
import {
  DEFAULT_HEADS_DOWN_CONFIG,
  getHeadsDownConfig,
  type HeadsDownConfig,
  startOfLocalDay,
} from "./config.ts";
import { PASS_LEASE_NAME, stopHeadsDown } from "./control.ts";
import { publish } from "./hub.ts";
import { type PassResult, runPass } from "./pass.ts";
import { getActiveRun, msUntilStop, passLimitReached, startRun } from "./service.ts";
import { setRescheduleHandler, setWakeHandler } from "./wake.ts";

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

/** How much longer than a pass's timeout its lease is held, so a crashed pass's lease just expires. */
const LEASE_MARGIN_MS = 5 * 60_000;

/** How often the loop looks again when there is no run, or another instance holds the lease. */
export const IDLE_CHECK_MS = 60_000;

/** What the loop runs on, replaceable so a test can drive it without a model or real timers. */
export interface LoopDeps {
  db: Db;
  /** `timeoutMs` is how long the pass may run; the loop's lease is sized from it. */
  runPass: (run: HeadsDownRun, timeoutMs: number) => Promise<PassResult>;
  minSleepMs: () => Promise<number>;
  passTimeoutMs: () => Promise<number>;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Always-on and the daily pass limit. Defaults to the stored settings. */
  config?: () => Promise<HeadsDownConfig>;
}

async function readConfig(): Promise<HeadsDownConfig> {
  try {
    return await getHeadsDownConfig();
  } catch {
    return DEFAULT_HEADS_DOWN_CONFIG;
  }
}

/** How long until the next local midnight, when the daily pass count starts over. */
export function msUntilNextDay(now = new Date()): number {
  const next = startOfLocalDay(now);
  next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function readMinSleepMs(): Promise<number> {
  try {
    return (await getHeadsDownConfig()).minSleepMinutes * 60_000;
  } catch {
    // A settings file that won't parse mustn't stop the loop.
    return DEFAULT_HEADS_DOWN_CONFIG.minSleepMinutes * 60_000;
  }
}

async function readPassTimeoutMs(): Promise<number> {
  try {
    return (await getHeadsDownConfig()).passTimeoutMinutes * 60_000;
  } catch {
    return DEFAULT_HEADS_DOWN_CONFIG.passTimeoutMinutes * 60_000;
  }
}

export interface HeadsDownLoop {
  stop: () => void;
  wake: () => void;
  /** Re-reads the run's stop time and sleeps no later than it, without running a pass. */
  reschedule: () => Promise<void>;
  /** Runs one cycle now and resolves when it is done, for tests. */
  cycle: () => Promise<void>;
}

export function createHeadsDownLoop(deps: LoopDeps): HeadsDownLoop {
  const { db } = deps;
  let stopped = false;
  let running = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * When the loop means to look again, as epoch ms: what the last pass chose,
   * or now when woken. The timer may be set sooner, for a stop time; kept
   * apart so moving or clearing that stop time can go back to this.
   */
  let sleepUntil = 0;

  const setTimer = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = deps.setTimer(() => void cycle(), ms);
  };

  /** Sleeps `ms`, or until the run's stop time when that comes first. */
  const schedule = (ms: number, untilStop = Infinity) => {
    sleepUntil = Date.now() + ms;
    setTimer(Math.min(ms, untilStop));
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
    let untilStop = Infinity;
    try {
      const hd = await (deps.config ?? readConfig)();
      let run = await getActiveRun(db);
      if (!run && hd.alwaysOn) {
        run = await startRun(db, null);
        publish({ type: "changed" });
      }
      let ranPass = false;
      if (run && msUntilStop(run) === 0) {
        await stopHeadsDown(db);
      } else if (run && !run.pausedAt && (await passLimitReached(db, hd))) {
        // A wake or message can't start a pass before the count starts over.
        nextMs = msUntilNextDay() + 1000;
      } else if (run && !run.pausedAt) {
        // Read once, so the lease and the pass agree even if the setting changes mid-pass.
        const timeoutMs = await deps.passTimeoutMs();
        if (await claimJob(db, PASS_LEASE_NAME, timeoutMs + LEASE_MARGIN_MS)) {
          ranPass = true;
          let status: "ok" | "error" = "ok";
          try {
            nextMs = (await deps.runPass(run, timeoutMs)).sleepMinutes * 60_000;
          } catch (e) {
            status = "error";
            console.error("[heads-down] pass failed:", e);
          } finally {
            await finishJob(db, PASS_LEASE_NAME, { status });
          }
        }
      }
      // Woken during the pass: something changed that the pass may not have seen.
      if (wakeRequested) nextMs = Math.min(nextMs, await deps.minSleepMs());
      // A wake-up a pass scheduled ends the sleep early. Only after a pass, so
      // one that is due but can't run yet (another instance holds the lease)
      // doesn't spin the loop.
      if (ranPass) {
        const [wake] = await listPendingWakes(db);
        if (wake) nextMs = Math.min(nextMs, Math.max(wake.dueAt.getTime() - Date.now(), 0));
      }
      // Read again: the stop time may have changed while the pass ran.
      untilStop = msUntilStop(await getActiveRun(db));
    } catch (e) {
      console.error("[heads-down] loop cycle failed:", e);
    } finally {
      running = false;
      schedule(nextMs, untilStop);
    }
  };

  const wake = () => {
    if (running) wakeRequested = true;
    else schedule(0);
  };

  const reschedule = async () => {
    // A cycle in flight reads the stop time again when it ends.
    if (running || stopped) return;
    try {
      const untilStop = msUntilStop(await getActiveRun(db));
      // Checked again: a cycle may have started while the run was read.
      if (running || stopped) return;
      setTimer(Math.min(Math.max(0, sleepUntil - Date.now()), untilStop));
    } catch (e) {
      console.error("[heads-down] rescheduling failed:", e);
    }
  };

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    wake,
    reschedule,
    cycle,
  };
}

export function startHeadsDownLoop(config: Config): () => void {
  if (!config.databaseUrl) return () => {};
  const db = getDb(config.databaseUrl).db;
  const loop = createHeadsDownLoop({
    db,
    runPass: (run, timeoutMs) => runPass(config, db, run, { timeoutMs }),
    minSleepMs: readMinSleepMs,
    passTimeoutMs: readPassTimeoutMs,
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  setWakeHandler(loop.wake);
  setRescheduleHandler(() => void loop.reschedule());

  // A workspace session raising attention (waiting on permission, finished)
  // is worth a look, but no more often than the shortest sleep. Only a
  // workspace's own items count: heads-down mode's questions go to the bell
  // too, and a pass asking one mustn't wake the loop it is part of.
  let lastAttentionWake = 0;
  const onAttention = async (item: AttentionItemRow) => {
    if (!item.workspaceId || item.status !== "pending") return;
    try {
      const now = Date.now();
      if (now - lastAttentionWake < (await readMinSleepMs())) return;
      lastAttentionWake = now;
      if (await getActiveRun(db)) loop.wake();
    } catch (e) {
      console.error("[heads-down] attention wake failed:", e);
    }
  };
  const unsubscribe = subscribeAttention((item) => void onAttention(item));

  loop.wake();
  return () => {
    loop.stop();
    unsubscribe();
    setWakeHandler(null);
    setRescheduleHandler(null);
  };
}
