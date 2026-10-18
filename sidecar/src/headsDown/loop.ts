import { subscribe as subscribeAttention } from "../attention/hub.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { claimJob, finishJob } from "../jobs/store.ts";
import { getHeadsDownConfig } from "./config.ts";
import { PASS_TIMEOUT_MS, runPass } from "./pass.ts";
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
const IDLE_CHECK_MS = 60_000;

export function startHeadsDownLoop(config: Config): () => void {
  if (!config.databaseUrl) return () => {};
  const db = getDb(config.databaseUrl).db;
  let stopped = false;
  let running = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastAttentionWake = 0;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void cycle(), ms);
  };

  const cycle = async () => {
    if (running || stopped) {
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
          nextMs = (await runPass(config, db, run)).sleepMinutes * 60_000;
        } catch (e) {
          status = "error";
          console.error("[heads-down] pass failed:", e);
        } finally {
          await finishJob(db, LEASE_NAME, { status });
        }
      }
    } catch (e) {
      console.error("[heads-down] loop cycle failed:", e);
    } finally {
      running = false;
    }
    // Woken during the pass: something changed that the pass may not have seen.
    if (wakeRequested)
      nextMs = Math.min(nextMs, (await getHeadsDownConfig()).minSleepMinutes * 60_000);
    schedule(nextMs);
  };

  const wake = () => {
    if (running) wakeRequested = true;
    else schedule(0);
  };
  setWakeHandler(wake);

  // A workspace session raising attention (waiting on permission, finished)
  // is worth a look, but no more often than the shortest sleep.
  const unsubscribe = subscribeAttention(() => {
    void getHeadsDownConfig().then((hd) => {
      const now = Date.now();
      if (now - lastAttentionWake < hd.minSleepMinutes * 60_000) return;
      lastAttentionWake = now;
      void getActiveRun(db).then((run) => {
        if (run) wake();
      });
    });
  });

  schedule(0);
  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    setWakeHandler(null);
  };
}
