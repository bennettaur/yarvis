import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { attentionItems, stallReminders } from "../db/schema.ts";
import { withSection } from "../settings/store.ts";
import type { DanglingItem, DanglingWork } from "./service.ts";
import {
  DEFAULT_STALLED_WORK_CONFIG,
  duration,
  getStalledWorkConfig,
  runStalledWorkReminders,
  type StalledDeps,
} from "./stalled.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

const HOUR = 60 * 60 * 1000;
const start = new Date("2026-11-23T09:00:00Z");

let clock: Date;
let work: DanglingWork;
let deps: StalledDeps;

const review = (over: Partial<DanglingItem> = {}): DanglingItem => ({
  key: "gh:o/r/7",
  kind: "review-in-progress",
  title: "o/r#7 Add caching",
  reason: "you looked at or commented on this but never signed it off",
  navTarget: { type: "pr", owner: "o", repo: "r", number: 7 },
  category: "review",
  waitingSince: start.toISOString(),
  ...over,
});

const at = (hours: number) => {
  clock = new Date(start.getTime() + hours * HOUR);
};
const items = () => db.select().from(attentionItems);
const run = () => runStalledWorkReminders(db, deps);

beforeEach(async () => {
  await sql`TRUNCATE stall_reminders, attention_items RESTART IDENTITY CASCADE`;
  clock = start;
  work = { items: [review()], unavailable: [] };
  deps = {
    findWork: async () => work,
    config: async () => DEFAULT_STALLED_WORK_CONFIG,
    now: () => clock,
  };
});

afterAll(async () => {
  await sql.end();
});

describe("runStalledWorkReminders", () => {
  it("reminds once the category's threshold has passed, linking back to the item", async () => {
    at(23);
    expect((await run()).reminded).toEqual([]);
    at(25);
    expect((await run()).reminded).toEqual(["gh:o/r/7"]);
    const [item] = await items();
    expect(item).toMatchObject({
      kind: "action",
      category: "review",
      title: "A review you started is unfinished",
      body: "o/r#7 Add caching\nYou looked at or commented on this but never signed it off. Waiting for 1 day.",
      navTarget: { type: "pr", owner: "o", repo: "r", number: 7 },
    });
  });

  it("waits longer before each later reminder, and stops after three", async () => {
    at(24);
    await run();
    // The second waits three thresholds after the first, the third nine.
    at(24 + 71);
    expect((await run()).reminded).toEqual([]);
    at(24 + 72);
    expect((await run()).reminded).toEqual(["gh:o/r/7"]);
    at(96 + 215);
    expect((await run()).reminded).toEqual([]);
    at(96 + 216);
    expect((await run()).reminded).toEqual(["gh:o/r/7"]);
    at(10_000);
    expect((await run()).reminded).toEqual([]);
    const [row] = await db.select().from(stallReminders);
    expect(row?.count).toBe(3);
  });

  it("stops for good once the user dismisses a reminder", async () => {
    at(24);
    await run();
    await db.update(attentionItems).set({ status: "dismissed" });
    at(1_000);
    expect(await run()).toMatchObject({ reminded: [], stopped: ["gh:o/r/7"] });
    // Coming back to the item later doesn't start them again.
    work = { items: [review({ waitingSince: new Date(clock).toISOString() })], unavailable: [] };
    at(2_000);
    expect((await run()).reminded).toEqual([]);
  });

  it("starts over, and settles the old reminder, when the user comes back to it", async () => {
    at(24);
    await run();
    at(30);
    work = { items: [review({ waitingSince: clock.toISOString() })], unavailable: [] };
    expect((await run()).reminded).toEqual([]);
    const [old] = await items();
    expect(old?.status).toBe("resolved");
    at(30 + 24);
    expect((await run()).reminded).toEqual(["gh:o/r/7"]);
    const [row] = await db.select().from(stallReminders);
    expect(row?.count).toBe(1);
  });

  it("clears a finished item's reminders, but not while its source can't be read", async () => {
    at(24);
    await run();
    work = { items: [], unavailable: ["github (rate limited)"] };
    expect((await run()).cleared).toBe(0);
    work = { items: [], unavailable: [] };
    expect((await run()).cleared).toBe(1);
    expect(await db.select().from(stallReminders)).toEqual([]);
    const [item] = await items();
    expect(item?.status).toBe("resolved");
  });

  it("keeps the count of an item still dangling but no longer counted as waiting", async () => {
    at(24);
    await run();
    work = { items: [review({ waitingSince: undefined })], unavailable: [] };
    expect((await run()).cleared).toBe(0);
    work = { items: [review()], unavailable: [] };
    at(24 + 71);
    expect((await run()).reminded).toEqual([]);
    const [row] = await db.select().from(stallReminders);
    expect(row?.count).toBe(1);
  });

  it("uses each category's own threshold and ignores items that can't stall", async () => {
    work = {
      items: [
        review({ key: "question:1", kind: "question", category: "slack" }),
        review({ key: "task:1", kind: "task", waitingSince: undefined }),
      ],
      unavailable: [],
    };
    at(8);
    expect((await run()).reminded).toEqual(["question:1"]);
    const [row] = await db
      .select()
      .from(stallReminders)
      .where(eq(stallReminders.itemKey, "question:1"));
    expect(row?.kind).toBe("question");
  });
});

describe("getStalledWorkConfig", () => {
  it("clamps hand-edited thresholds and ignores values that aren't numbers", async () => {
    await withSection("stalledWork", () => ({
      next: {
        enabled: "yes",
        thresholdHours: { review: 0.1, build: 100_000, slack: "8", general: 12 },
      },
      result: null,
    }));
    expect(await getStalledWorkConfig()).toEqual({
      enabled: true,
      thresholdHours: { review: 1, build: 720, slack: 8, general: 12 },
    });
    await withSection("stalledWork", () => ({ next: undefined, result: null }));
  });
});

describe("duration", () => {
  it("names the largest whole unit", () => {
    expect(duration(30 * 60_000)).toBe("30 minutes");
    expect(duration(HOUR)).toBe("1 hour");
    expect(duration(5 * HOUR)).toBe("5 hours");
    expect(duration(30 * HOUR)).toBe("1 day");
    expect(duration(80 * HOUR)).toBe("3 days");
  });
});
