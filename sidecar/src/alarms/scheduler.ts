import type { Config } from "../config.ts";
import { type CoreAlarm, fireAlarm, hasCoreChannel } from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { publish, subscribe } from "./hub.ts";
import { claimDueAlarms, nextDueAt, toAlarm, unclaimAlarm } from "./service.ts";

/**
 * Rings alarms when they come due. The sidecar decides an alarm is due and
 * marks it fired; the core does the ringing and the window takeover, since a
 * throttled background webview can't be trusted to.
 *
 * Runs only on the instance with background workers, like the heads-down loop.
 */

/**
 * The longest it waits between checks. A timer set for the next alarm can come
 * back late after the machine sleeps, and an alarm added by another instance
 * sharing the database publishes nothing here.
 */
export const MAX_WAIT_MS = 30_000;

/** How soon it tries again to ring an alarm the core couldn't, e.g. while it restarts. */
export const FIRE_RETRY_MS = 5_000;

export interface SchedulerDeps {
  db: Db;
  /** Hands a fired alarm to the core. */
  fire: (alarm: CoreAlarm) => Promise<void>;
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export interface AlarmScheduler {
  stop: () => void;
  /** Re-checks now, e.g. after an alarm was added or snoozed. */
  wake: () => void;
  /** Runs one check and resolves when it is done, for tests. */
  tick: () => Promise<void>;
}

export function createAlarmScheduler(deps: SchedulerDeps): AlarmScheduler {
  let stopped = false;
  let running = false;
  let wakeRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = deps.setTimer(() => void tick(), ms);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (running) {
      wakeRequested = true;
      return;
    }
    running = true;
    wakeRequested = false;
    let nextMs = MAX_WAIT_MS;
    try {
      const due = await claimDueAlarms(deps.db, new Date());
      let rang = 0;
      let failed = 0;
      for (const row of due) {
        try {
          await deps.fire(toAlarm(row));
          rang++;
        } catch (e) {
          failed++;
          console.error("[alarms] ringing on the core failed:", e instanceof Error ? e.message : e);
          await unclaimAlarm(deps.db, row.id);
        }
      }
      // Only a change worth telling the page about: an alarm put back after a
      // failed ring is where it was, and announcing it would wake this loop
      // straight into the same failure.
      if (rang > 0) publish({ type: "changed" });
      const next = await nextDueAt(deps.db);
      if (next) nextMs = Math.min(MAX_WAIT_MS, Math.max(0, next.getTime() - Date.now()));
      if (failed > 0) nextMs = Math.max(nextMs, FIRE_RETRY_MS);
    } catch (e) {
      console.error("[alarms] scheduler check failed:", e instanceof Error ? e.message : e);
    } finally {
      running = false;
      schedule(wakeRequested ? 0 : nextMs);
    }
  };

  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
    wake: () => {
      if (running) wakeRequested = true;
      else schedule(0);
    },
    tick,
  };
}

export function startAlarmScheduler(config: Config): () => void {
  if (!config.databaseUrl) return () => {};
  const scheduler = createAlarmScheduler({
    db: getDb(config.databaseUrl).db,
    fire: async (alarm) => {
      if (!hasCoreChannel()) {
        // `sidecar:dev` and tests run with no core: the alarm shows as ringing
        // on the Alarms tab, with no window takeover or sound.
        console.warn(`[alarms] no core to ring alarm ${alarm.id}`);
        return;
      }
      await fireAlarm(alarm);
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
  });
  // Its own `changed` after firing wakes it once more, which finds nothing due.
  const unsubscribe = subscribe((event) => {
    if (event.type === "changed") scheduler.wake();
  });
  scheduler.wake();
  return () => {
    scheduler.stop();
    unsubscribe();
  };
}
