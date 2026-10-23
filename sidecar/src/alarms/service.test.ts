import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../db/schema.ts";
import { subscribe } from "./hub.ts";
import { importLegacyAlarms } from "./legacyImport.ts";
import { createAlarmScheduler, MAX_WAIT_MS } from "./scheduler.ts";
import {
  acknowledgeAlarm,
  claimDueAlarms,
  createAlarm,
  findMeetingAlarm,
  listAlarms,
  listPendingAlarms,
  nextDueAt,
  snoozeAlarm,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000);

beforeEach(async () => {
  await sql`TRUNCATE alarms`;
});

afterAll(async () => {
  await sql.end();
});

describe("alarm service", () => {
  it("fires each due alarm once, even when claimed twice", async () => {
    const due = await createAlarm(db, { label: "due", fireAt: inMinutes(-1), source: "app" });
    await createAlarm(db, { label: "later", fireAt: inMinutes(10), source: "app" });

    const first = await claimDueAlarms(db, new Date());
    const second = await claimDueAlarms(db, new Date());

    expect(first.map((a) => a.id)).toEqual([due.id]);
    expect(first[0]?.status).toBe("fired");
    expect(second).toEqual([]);
  });

  it("reports the next scheduled alarm, ignoring ones already dealt with", async () => {
    const soon = await createAlarm(db, { label: "soon", fireAt: inMinutes(5), source: "app" });
    const later = await createAlarm(db, { label: "later", fireAt: inMinutes(20), source: "app" });
    expect((await nextDueAt(db))?.getTime()).toBe(soon.fireAt.getTime());

    await acknowledgeAlarm(db, soon.id);
    expect((await nextDueAt(db))?.getTime()).toBe(later.fireAt.getTime());
  });

  it("puts a snoozed alarm back on the schedule", async () => {
    const alarm = await createAlarm(db, { label: "a", fireAt: inMinutes(-1), source: "app" });
    await claimDueAlarms(db, new Date());

    const snoozed = await snoozeAlarm(db, alarm.id, 5);

    expect(snoozed?.status).toBe("scheduled");
    expect(snoozed!.fireAt.getTime()).toBeGreaterThan(inMinutes(4).getTime());
  });

  it("returns null for an alarm that doesn't exist", async () => {
    expect(await acknowledgeAlarm(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("matches a meeting alarm by label and a near fire time", async () => {
    const fireAt = inMinutes(30);
    await createAlarm(db, { label: "Meeting: Standup", fireAt, source: "app" });

    expect(
      await findMeetingAlarm(db, "Meeting: Standup", new Date(fireAt.getTime() + 30_000)),
    ).not.toBeNull();
    expect(await findMeetingAlarm(db, "Meeting: Standup", inMinutes(60))).toBeNull();
    expect(await findMeetingAlarm(db, "Meeting: Retro", fireAt)).toBeNull();
  });

  it("lists pending alarms soonest first", async () => {
    await createAlarm(db, { label: "later", fireAt: inMinutes(20), source: "app" });
    await createAlarm(db, { label: "sooner", fireAt: inMinutes(5), source: "chat" });
    const done = await createAlarm(db, { label: "done", fireAt: inMinutes(1), source: "app" });
    await acknowledgeAlarm(db, done.id);

    expect((await listPendingAlarms(db)).map((a) => a.label)).toEqual(["sooner", "later"]);
  });

  it("tells listeners when the list changes", async () => {
    let changes = 0;
    const unsubscribe = subscribe((e) => {
      if (e.type === "changed") changes++;
    });
    try {
      const alarm = await createAlarm(db, { label: "a", fireAt: inMinutes(5), source: "app" });
      await acknowledgeAlarm(db, alarm.id);
    } finally {
      unsubscribe();
    }
    expect(changes).toBe(2);
  });
});

describe("alarm scheduler", () => {
  function scheduler(fired: string[], timers: number[]) {
    return createAlarmScheduler({
      db,
      fire: async (alarm) => {
        fired.push(alarm.label);
      },
      setTimer: (_fn, ms) => {
        timers.push(ms);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    });
  }

  it("rings due alarms and waits until the next one", async () => {
    await createAlarm(db, { label: "due", fireAt: inMinutes(-1), source: "app" });
    await createAlarm(db, { label: "soon", fireAt: new Date(Date.now() + 10_000), source: "app" });
    const fired: string[] = [];
    const timers: number[] = [];

    await scheduler(fired, timers).tick();

    expect(fired).toEqual(["due"]);
    expect(timers.at(-1)).toBeLessThanOrEqual(10_000);
    expect(timers.at(-1)).toBeGreaterThan(5_000);
  });

  it("checks again within the longest wait when nothing is scheduled", async () => {
    const fired: string[] = [];
    const timers: number[] = [];

    await scheduler(fired, timers).tick();

    expect(fired).toEqual([]);
    expect(timers.at(-1)).toBe(MAX_WAIT_MS);
  });

  it("keeps the alarm fired when the core can't ring it", async () => {
    await createAlarm(db, { label: "due", fireAt: inMinutes(-1), source: "app" });
    const s = createAlarmScheduler({
      db,
      fire: async () => {
        throw new Error("no core");
      },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    });

    await s.tick();

    expect((await listAlarms(db))[0]?.status).toBe("fired");
  });
});

describe("importLegacyAlarms", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yarvis-alarms-import-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the old alarms in order and renames the file", async () => {
    const path = join(dir, "alarms.json");
    const legacy = [
      {
        id: "a1",
        label: "Standup",
        fireAtMs: inMinutes(30).getTime(),
        sound: true,
        meetLink: "https://meet/x",
        status: "scheduled",
      },
      { id: "a2", label: "Old", fireAtMs: inMinutes(-60).getTime(), status: "acknowledged" },
      { id: "a3", label: 42, fireAtMs: 0, status: "scheduled" },
    ];
    writeFileSync(path, JSON.stringify(legacy));

    expect(await importLegacyAlarms(db, path)).toBe(2);

    const rows = await listAlarms(db);
    expect(rows.map((a) => [a.label, a.status, a.meetLink])).toEqual([
      ["Standup", "scheduled", "https://meet/x"],
      ["Old", "acknowledged", null],
    ]);
    expect(JSON.parse(readFileSync(`${path}.imported`, "utf8"))).toEqual(legacy);
    // A second start finds nothing left to copy.
    expect(await importLegacyAlarms(db, path)).toBe(0);
    expect(await listAlarms(db)).toHaveLength(2);
  });

  it("does nothing when there is no file", async () => {
    expect(await importLegacyAlarms(db, join(dir, "missing.json"))).toBe(0);
  });

  it("leaves a file that doesn't parse where it is", async () => {
    const path = join(dir, "alarms.json");
    writeFileSync(path, "{not json");
    expect(await importLegacyAlarms(db, path)).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("{not json");
  });
});
