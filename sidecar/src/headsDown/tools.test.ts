import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { selectTools } from "../agents/run.ts";
import { ALWAYS_CONFIRM_BUILTIN_TOOLS } from "../chat/destructiveTools.ts";
import * as schema from "../db/schema.ts";
import { NOT_RUNNING, parseStopTime, STOP_TIME_PASSED } from "./control.ts";
import { PASS_REFUSED_TOOLS } from "./policy.ts";
import { reloadRoutines } from "./routines.ts";
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

describe("the chat's routine tools", () => {
  let dir: string;
  const made: string[] = [];
  const original = process.env.YARVIS_ROUTINES_DIR;
  const originalSettings = process.env.YARVIS_SETTINGS_PATH;

  beforeEach(async () => {
    const parent = mkdtempSync(join(tmpdir(), "chat-routines-"));
    made.push(parent);
    dir = join(parent, "routines");
    process.env.YARVIS_ROUTINES_DIR = dir;
    // The switches are settings, so each test writes its own file.
    process.env.YARVIS_SETTINGS_PATH = join(parent, "settings.json");
    await reloadRoutines();
  });
  afterAll(async () => {
    process.env.YARVIS_ROUTINES_DIR = original;
    process.env.YARVIS_SETTINGS_PATH = originalSettings;
    await reloadRoutines();
    for (const parent of made) rmSync(parent, { recursive: true, force: true });
  });

  it("asks the user before writing or turning one on, and a pass or specialist never gets either", () => {
    for (const name of ["save_heads_down_routine", "set_heads_down_routine_enabled"]) {
      expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has(name)).toBe(true);
      expect(PASS_REFUSED_TOOLS.has(name)).toBe(true);
    }
    // Even a specialist file granting them as unattended doesn't get them.
    const specialistTools = selectTools(
      tools as never,
      [
        "builtin:save_heads_down_routine",
        "builtin:set_heads_down_routine_enabled",
        "builtin:list_heads_down_routines",
      ],
      { grantedIds: ["builtin:save_heads_down_routine", "builtin:set_heads_down_routine_enabled"] },
    );
    expect(Object.keys(specialistTools)).toEqual(["list_heads_down_routines"]);
    expect(ALWAYS_CONFIRM_BUILTIN_TOOLS.has("list_heads_down_routines")).toBe(false);
  });

  it("writes a one-off, lists it with its body, and turns a shipped one on", async () => {
    const saved = await tools.save_heads_down_routine.execute!(
      {
        name: "check-release",
        description: "Checks the release channel",
        once: true,
        tools: ["slack_read_channel"],
        config: { channel: "#releases" },
        body: "Read the release channel and tell me what shipped today.",
      },
      opts,
    );
    expect(saved).toMatchObject({ ok: true, path: join(dir, "check-release.md") });

    type Listed = { routines: { name: string; body?: string }[] };
    const all = (await tools.list_heads_down_routines.execute!({}, opts)) as Listed;
    // Bodies only for the routine asked about, so a routine chat doesn't carry every one.
    expect(all.routines.every((r) => r.body === undefined)).toBe(true);
    const one = (await tools.list_heads_down_routines.execute!(
      { name: "check-release" },
      opts,
    )) as Listed;
    expect(one.routines.find((r) => r.name === "check-release")).toMatchObject({
      once: true,
      every: null,
      config: { channel: "#releases" },
      body: "Read the release channel and tell me what shipped today.",
    });
    expect(one.routines.filter((r) => r.body !== undefined)).toHaveLength(1);

    expect(
      await tools.set_heads_down_routine_enabled.execute!(
        { name: "review-prep", enabled: true },
        opts,
      ),
    ).toEqual({ ok: true, enabled: true });
    // The switch shows in the list, and the shipped routine stays shipped.
    const after = (await tools.list_heads_down_routines.execute!(
      { name: "review-prep" },
      opts,
    )) as { routines: { name: string; enabled: boolean; source: string }[] };
    expect(after.routines.find((r) => r.name === "review-prep")).toMatchObject({
      enabled: true,
      source: "builtin",
    });
  });

  it("refuses a routine with neither a cadence nor once, and invisible text", () => {
    const schema = tools.save_heads_down_routine.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    const routine = { name: "x", description: "x", body: "Do it." };
    expect(schema.safeParse(routine).success).toBe(false);
    expect(schema.safeParse({ ...routine, every: "1d" }).success).toBe(true);
    expect(schema.safeParse({ ...routine, once: true, body: "Do​ it." }).success).toBe(false);
  });
});
