import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { createHeadsDownLoop, IDLE_CHECK_MS, type LoopDeps } from "./loop.ts";
import { startRun } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const MIN_SLEEP_MS = 5 * 60_000;

/** A loop whose timers are recorded rather than run, and whose pass is a stub. */
function testLoop(runPass: LoopDeps["runPass"]) {
  const scheduled: number[] = [];
  const loop = createHeadsDownLoop({
    db,
    runPass,
    minSleepMs: async () => MIN_SLEEP_MS,
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
  await sql`TRUNCATE heads_down_runs, job_runs RESTART IDENTITY CASCADE`;
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

  it("schedules nothing once stopped", async () => {
    await startRun(db, null);
    const { loop, scheduled } = testLoop(sleeping(10));

    loop.stop();
    await loop.cycle();
    expect(scheduled).toEqual([]);
  });
});
