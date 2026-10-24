import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { NOT_RUNNING, parseStopTime, STOP_TIME_PASSED } from "./control.ts";
import { getActiveRun } from "./service.ts";
import { buildHeadsDownTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });
const tools = buildHeadsDownTools(db);
const opts = {} as never;

beforeEach(async () => {
  await sql`TRUNCATE heads_down_runs, heads_down_questions, attention_items RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("reading a stop time", () => {
  it("takes a local HH:MM as its next occurrence, and an ISO timestamp as given", () => {
    const now = new Date(2026, 9, 19, 12, 0);
    expect(parseStopTime("19:00", now)).toEqual(new Date(2026, 9, 19, 19, 0));
    expect(parseStopTime("08:30", now)).toEqual(new Date(2026, 9, 20, 8, 30));
    expect(parseStopTime("12:00", now)).toEqual(new Date(2026, 9, 20, 12, 0));
    expect(parseStopTime("2026-10-19T23:00:00-04:00", now)).toEqual(
      new Date("2026-10-20T03:00:00Z"),
    );
    expect(parseStopTime("7pm", now)).toBeNull();
    expect(parseStopTime("25:00", now)).toBeNull();
  });
});

describe("the chat's heads-down tools", () => {
  it("won't start with a stop time already passed", async () => {
    const result = await tools.start_heads_down.execute!(
      { stopAt: new Date(Date.now() - 60_000).toISOString() },
      opts,
    );
    expect(result).toEqual({ error: STOP_TIME_PASSED });
    expect(await getActiveRun(db)).toBeNull();
  });

  it("sets a stop time from the user's local HH:MM, and refuses one when nothing runs", async () => {
    expect(await tools.set_heads_down_stop_time.execute!({ stopAt: "19:00" }, opts)).toEqual({
      error: NOT_RUNNING,
    });

    await tools.start_heads_down.execute!({}, opts);
    const result = (await tools.set_heads_down_stop_time.execute!({ stopAt: "19:00" }, opts)) as {
      stopAt: string;
    };
    const stopAt = new Date(result.stopAt);
    expect(stopAt.getHours()).toBe(19);
    expect(stopAt.getTime()).toBeGreaterThan(Date.now());
    expect(stopAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("reports whether it is paused and when it stops", async () => {
    await tools.start_heads_down.execute!({ stopAt: "19:00" }, opts);
    await tools.pause_heads_down.execute!({}, opts);

    const status = (await tools.heads_down_status.execute!({}, opts)) as Record<string, unknown>;
    expect(status).toMatchObject({ running: true, paused: true });
    expect(status.stopAt).toBeString();
  });

  it("says so when there is nothing to pause or resume", async () => {
    expect(await tools.pause_heads_down.execute!({}, opts)).toMatchObject({ paused: false });
    await tools.start_heads_down.execute!({}, opts);
    expect(await tools.resume_heads_down.execute!({}, opts)).toMatchObject({ resumed: false });
  });
});
