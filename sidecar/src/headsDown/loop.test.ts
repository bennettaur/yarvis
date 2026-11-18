import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { askUser } from "./attention.ts";
import { createHeadsDownLoop, IDLE_CHECK_MS, type LoopDeps } from "./loop.ts";
import { getActiveRun, listQuestions, pauseRun, setStopAt, startRun } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const MIN_SLEEP_MS = 5 * 60_000;
const PASS_TIMEOUT_MS = 90 * 60_000;

/** A loop whose timers are recorded rather than run, and whose pass is a stub. */
function testLoop(runPass: LoopDeps["runPass"]) {
  const scheduled: number[] = [];
  const loop = createHeadsDownLoop({
    db,
    runPass,
    minSleepMs: async () => MIN_SLEEP_MS,
    passTimeoutMs: async () => PASS_TIMEOUT_MS,
    setTimer: (_fn, ms) => {
      scheduled.push(ms);
      return setTimeout(() => {}, 0);
    },
  });
  return { loop, scheduled };
}

const sleeping = (minutes: number) => async () => ({
  passId: "p",
  sleepMinutes: minutes,
  sleepReason: "test",
});

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_questions, attention_items, job_runs RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("the heads-down loop", () => {
  it("checks back later and runs no pass while heads-down mode is off", async () => {
    let passes = 0;
    const { loop, scheduled } = testLoop(async () => {
      passes++;
      return sleeping(10)();
    });

    await loop.cycle();
    expect(passes).toBe(0);
    expect(scheduled).toEqual([IDLE_CHECK_MS]);
    loop.stop();
  });

  it("sleeps for as long as the pass decided, and releases the lease", async () => {
    await startRun(db, null);
    const { loop, scheduled } = testLoop(sleeping(10));

    await loop.cycle();
    expect(scheduled).toEqual([10 * 60_000]);
    const [lease] =
      await sql`SELECT lease_until, last_status FROM job_runs WHERE name = 'heads-down'`;
    expect(lease).toMatchObject({ lease_until: null, last_status: "ok" });
    loop.stop();
  });

  it("gives the pass the configured timeout, and holds the lease past it", async () => {
    await startRun(db, null);
    let leaseMs = 0;
    let passTimeoutMs = 0;
    const { loop } = testLoop(async (_run, timeoutMs) => {
      passTimeoutMs = timeoutMs;
      const [lease] = await sql`SELECT lease_until FROM job_runs WHERE name = 'heads-down'`;
      leaseMs = new Date(lease?.lease_until).getTime() - Date.now();
      return sleeping(10)();
    });

    await loop.cycle();
    expect(passTimeoutMs).toBe(PASS_TIMEOUT_MS);
    expect(leaseMs).toBeGreaterThan(PASS_TIMEOUT_MS);
    loop.stop();
  });

  it("looks again soon when woken during a pass", async () => {
    await startRun(db, null);
    let wakeDuringPass: () => void = () => {};
    const { loop, scheduled } = testLoop(async () => {
      wakeDuringPass();
      return sleeping(60)();
    });
    wakeDuringPass = loop.wake;

    await loop.cycle();
    expect(scheduled).toEqual([MIN_SLEEP_MS]);
    loop.stop();
  });

  it("keeps going after a pass throws, and records the failure on the lease", async () => {
    await startRun(db, null);
    const { loop, scheduled } = testLoop(async () => {
      throw new Error("provider down");
    });

    await loop.cycle();
    expect(scheduled).toEqual([IDLE_CHECK_MS]);
    const [lease] = await sql`SELECT last_status FROM job_runs WHERE name = 'heads-down'`;
    expect(lease?.last_status).toBe("error");
    loop.stop();
  });

  it("runs no pass while paused, and checks back later", async () => {
    await startRun(db, null);
    await pauseRun(db);
    let passes = 0;
    const { loop, scheduled } = testLoop(async () => {
      passes++;
      return sleeping(10)();
    });

    await loop.cycle();
    expect(passes).toBe(0);
    expect(scheduled).toEqual([IDLE_CHECK_MS]);
    loop.stop();
  });

  it("stops the run once its stop time has come, without a pass", async () => {
    await startRun(db, null);
    await setStopAt(db, new Date(Date.now() - 1000));
    let passes = 0;
    const { loop } = testLoop(async () => {
      passes++;
      return sleeping(10)();
    });

    await loop.cycle();
    expect(passes).toBe(0);
    expect(await getActiveRun(db)).toBeNull();
    loop.stop();
  });

  it("stops a paused run once its stop time has passed, dismissing its questions", async () => {
    await startRun(db, null);
    await askUser(db, { kind: "question", question: "Which repo?" });
    await pauseRun(db);
    await setStopAt(db, new Date(Date.now() - 1000));
    const { loop } = testLoop(sleeping(10));

    await loop.cycle();
    expect(await getActiveRun(db)).toBeNull();
    expect(await listQuestions(db)).toEqual([]);
    loop.stop();
  });

  it("counts a stop time a moment away as come, rather than starting a pass", async () => {
    await startRun(db, null, { stopAt: new Date(Date.now() + 500) });
    let passes = 0;
    const { loop } = testLoop(async () => {
      passes++;
      return sleeping(10)();
    });

    await loop.cycle();
    expect(passes).toBe(0);
    expect(await getActiveRun(db)).toBeNull();
    loop.stop();
  });

  it("sleeps no later than the stop time", async () => {
    await startRun(db, null, { stopAt: new Date(Date.now() + 3 * 60_000) });
    const { loop, scheduled } = testLoop(sleeping(60));

    await loop.cycle();
    expect(scheduled[0]).toBeLessThanOrEqual(3 * 60_000);
    expect(scheduled[0]).toBeGreaterThan(2 * 60_000);
    loop.stop();
  });

  it("wakes in time for a stop time set while it sleeps, without a pass", async () => {
    await startRun(db, null);
    let passes = 0;
    const { loop, scheduled } = testLoop(async () => {
      passes++;
      return sleeping(60)();
    });
    await loop.cycle();
    expect(scheduled).toEqual([60 * 60_000]);

    await setStopAt(db, new Date(Date.now() + 5 * 60_000));
    await loop.reschedule();
    expect(passes).toBe(1);
    expect(scheduled[1]).toBeLessThanOrEqual(5 * 60_000);
    expect(scheduled[1]).toBeGreaterThan(4 * 60_000);
    loop.stop();
  });

  it("goes back to the sleep the pass chose when the stop time moves later again", async () => {
    await startRun(db, null);
    const { loop, scheduled } = testLoop(sleeping(60));
    await loop.cycle();

    await setStopAt(db, new Date(Date.now() + 5 * 60_000));
    await loop.reschedule();
    expect(scheduled[1]).toBeLessThanOrEqual(5 * 60_000);

    await setStopAt(db, new Date(Date.now() + 3 * 60 * 60_000));
    await loop.reschedule();
    expect(scheduled[2]).toBeLessThanOrEqual(60 * 60_000);
    expect(scheduled[2]).toBeGreaterThan(59 * 60_000);
    loop.stop();
  });

  it("schedules nothing once stopped", async () => {
    await startRun(db, null);
    const { loop, scheduled } = testLoop(sleeping(10));

    loop.stop();
    await loop.cycle();
    expect(scheduled).toEqual([]);
  });
});
