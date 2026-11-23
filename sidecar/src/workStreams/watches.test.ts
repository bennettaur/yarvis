import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { listAttention } from "../attention/service.ts";
import * as schema from "../db/schema.ts";
import { buildPassTools, newPassOutcome } from "../headsDown/passTools.ts";
import { createStream, getStream, updateStream } from "./service.ts";
import { buildWorkStreamTools, WATCH_REPORTED_ONLY } from "./tools.ts";
import {
  dueWatches,
  expireWatches,
  WATCH_EXPIRED_TITLE,
  WATCH_MET_TITLE,
  watchFields,
} from "./watches.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

const HOUR = 60 * 60_000;

beforeEach(async () => {
  await sql`TRUNCATE work_streams, work_stream_links, attention_items, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

function watch(title: string, overrides: Partial<schema.WorkStream> = {}, now = new Date()) {
  const fields = watchFields({ condition: `${title} happened`, every: "1h", expiresIn: "2d" }, now);
  if ("error" in fields) throw new Error(fields.error);
  return createStream(db, { title, watch: fields, ...overrides });
}

describe("watchFields", () => {
  it("defaults to hourly checks for a week", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    expect(watchFields({ condition: "  CI is green " }, now)).toEqual({
      condition: "CI is green",
      everyMinutes: 60,
      expiresAt: new Date("2026-11-30T10:00:00Z"),
    });
  });

  it("refuses cadences and lifetimes out of range", () => {
    expect(watchFields({ condition: "x", every: "5m" })).toHaveProperty("error");
    expect(watchFields({ condition: "x", every: "8d" })).toHaveProperty("error");
    expect(watchFields({ condition: "x", expiresIn: "31d" })).toHaveProperty("error");
    expect(watchFields({ condition: "x", every: "1d", expiresIn: "2h" })).toHaveProperty("error");
    expect(watchFields({ condition: " " })).toHaveProperty("error");
  });
});

describe("creating a watch from chat", () => {
  it("makes a watch stream that waits on others, and shows its condition", async () => {
    const tools = buildWorkStreamTools(db);
    const created = (await tools.create_work_stream.execute!(
      {
        title: "Alex's billing PRs",
        category: "review",
        watch: { condition: "alex merged acme/billing#41 and #42", every: "30m", expiresIn: "3d" },
      },
      opts,
    )) as { id: string; kind: string; status: string; expiresAt: string };
    expect(created).toMatchObject({ kind: "watch", status: "waiting-on-others" });
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now() + 71 * HOUR);

    const listed = (await tools.list_work_streams.execute!({}, opts)) as {
      streams: { id: string; watch?: { condition: string; everyMinutes: number } }[];
    };
    expect(listed.streams[0]?.watch?.everyMinutes).toBe(30);
    expect(listed.streams[0]?.watch?.condition).toContain("alex merged acme/billing#41");
  });

  it("refuses a bad duration", async () => {
    const tools = buildWorkStreamTools(db);
    const result = await tools.create_work_stream.execute!(
      { title: "x", watch: { condition: "y", every: "1m" } },
      opts,
    );
    expect(result).toHaveProperty("error");
  });

  it("is the user's alone: a pass can't set one up, list one as work, or change one", async () => {
    const pass = buildWorkStreamTools(db, { unattended: true });
    expect(
      await pass.create_work_stream.execute!({ title: "x", watch: { condition: "y" } }, opts),
    ).toEqual({ error: "only the user sets up a watch" });

    const w = await watch("deploy");
    const work = await createStream(db, { title: "ship billing" });
    const listed = (await pass.list_work_streams.execute!({}, opts)) as {
      streams: { id: string }[];
    };
    expect(listed.streams.map((s) => s.id)).toEqual([work.id]);
    expect(await pass.update_work_stream.execute!({ id: w.id, status: "done" }, opts)).toEqual({
      error: WATCH_REPORTED_ONLY,
    });
  });
});

describe("dueWatches", () => {
  it("gives the never-checked first, then the longest waiting, and skips the rest", async () => {
    const now = new Date();
    const checkedEarlier = await watch("checked earlier");
    await updateStream(db, checkedEarlier.id, { wakeAt: new Date(now.getTime() - HOUR) });
    const fresh = await watch("fresh");
    const snoozed = await watch("snoozed");
    await updateStream(db, snoozed.id, { wakeAt: new Date(now.getTime() + HOUR) });
    const paused = await watch("paused");
    await updateStream(db, paused.id, { paused: true });
    const closed = await watch("closed");
    await updateStream(db, closed.id, { status: "dropped" });
    await createStream(db, { title: "plain work" });

    expect((await dueWatches(db, now)).map((w) => w.title)).toEqual([
      fresh.title,
      checkedEarlier.title,
    ]);
    expect(await dueWatches(db, now, 1)).toHaveLength(1);
  });
});

describe("report_watch", () => {
  async function passTools(offered: string[]) {
    let changed = 0;
    const tools = buildPassTools(
      db,
      newPassOutcome(),
      () => changed++,
      new Set(),
      [],
      undefined,
      offered,
    );
    return { tools, changed: () => changed };
  }

  it("only takes the watches the pass was given", async () => {
    const w = await watch("deploy");
    const { tools } = await passTools([]);
    expect(
      await tools.report_watch.execute!({ id: w.id, met: true, finding: "shipped" }, opts),
    ).toEqual({ error: "that watch wasn't given to this pass to check" });
    expect((await getStream(db, w.id))?.status).toBe("waiting-on-others");
  });

  it("not met: keeps it open, records the finding and moves the next check on", async () => {
    const w = await watch("deploy");
    const { tools } = await passTools([w.id]);
    const before = Date.now();
    await tools.report_watch.execute!({ id: w.id, met: false, finding: "still rolling out" }, opts);
    const after = await getStream(db, w.id);
    expect(after?.status).toBe("waiting-on-others");
    expect(after?.waitingOn).toBe("still rolling out");
    expect(after?.wakeAt?.getTime()).toBeGreaterThanOrEqual(before + HOUR);
    expect(await listAttention(db, { status: "pending" })).toEqual([]);
  });

  it("met: tells the user under app text, then closes it", async () => {
    const w = await watch("Alex's PRs", { category: "review" });
    const { tools, changed } = await passTools([w.id]);
    await tools.report_watch.execute!(
      {
        id: w.id,
        met: true,
        finding: "Both merged at 14:02",
        navTarget: { type: "pr", owner: "acme", repo: "billing", number: 41 },
      },
      opts,
    );
    expect((await getStream(db, w.id))?.status).toBe("done");
    const [item] = await listAttention(db, { status: "pending" });
    expect(item).toMatchObject({
      kind: "message",
      category: "review",
      title: WATCH_MET_TITLE,
      body: "Alex's PRs\nBoth merged at 14:02",
      navTarget: { type: "pr", owner: "acme", repo: "billing", number: 41 },
    });
    expect(changed()).toBe(1);

    expect(
      await tools.report_watch.execute!({ id: w.id, met: true, finding: "again" }, opts),
    ).toEqual({ error: "that watch is closed" });
  });
});

describe("expireWatches", () => {
  it("closes a watch past its expiry once, and says so", async () => {
    const created = new Date(Date.now() - 3 * 24 * HOUR);
    const old = await watch("old deploy", {}, created);
    const live = await watch("live deploy");
    await updateStream(db, live.id, { paused: true });

    const expired = await expireWatches(db, new Date());
    expect(expired.map((w) => w.id)).toEqual([old.id]);
    expect((await getStream(db, old.id))?.status).toBe("dropped");
    expect(await expireWatches(db, new Date())).toEqual([]);

    const items = await listAttention(db, { status: "pending" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "message",
      category: "general",
      title: WATCH_EXPIRED_TITLE,
      navTarget: { type: "heads-down" },
    });
    expect(items[0]?.body).toContain("old deploy happened");
  });
});
