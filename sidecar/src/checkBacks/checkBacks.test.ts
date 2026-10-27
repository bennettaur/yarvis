import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { builtinToolMetadata } from "../chat/builtinTools.ts";
import { CHECK_BACK_TOOLS } from "../chat/destructiveTools.ts";
import { createSession } from "../chat/service.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import type { JobContext } from "../jobs/scheduler.ts";
import { type CheckBackTurnRunner, checkBackMessage, checkBacksJob } from "./job.ts";
import {
  cancelCheckBack,
  claimDueCheckBacks,
  listPendingCheckBacks,
  MAX_CHECK_BACK_ATTEMPTS,
  MAX_PENDING_PER_SESSION,
  scheduleCheckBack,
} from "./service.ts";
import { buildCheckBackTools } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

const config = { secrets: {} } as unknown as Config;
const opts = { toolCallId: "test", messages: [] } as never;

beforeEach(async () => {
  await sql`TRUNCATE chat_sessions, attention_items RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

const base = { provider: "anthropic", model: "claude", attempt: 1, delayMinutes: 10 };

async function newChat(): Promise<string> {
  return (await createSession(db)).id;
}

function ctx(now: Date): JobContext {
  return { db, config, cursor: null, now, trigger: "schedule" };
}

describe("scheduling", () => {
  it("stores a check-back due after the delay", async () => {
    const sessionId = await newChat();
    const now = new Date("2026-10-16T12:00:00Z");
    const result = await scheduleCheckBack(db, { ...base, sessionId, prompt: "is CI green?" }, now);
    if ("error" in result) throw new Error(result.error);
    expect(result.checkBack.dueAt.toISOString()).toBe("2026-10-16T12:10:00.000Z");
    expect(result.checkBack.status).toBe("pending");
  });

  it("refuses a chain that has run out of attempts", async () => {
    const sessionId = await newChat();
    const result = await scheduleCheckBack(db, {
      ...base,
      sessionId,
      prompt: "again",
      attempt: MAX_CHECK_BACK_ATTEMPTS + 1,
    });
    expect("error" in result).toBe(true);
    expect(await listPendingCheckBacks(db, sessionId)).toHaveLength(0);
  });

  it("caps how many one chat can have waiting", async () => {
    const sessionId = await newChat();
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      await scheduleCheckBack(db, { ...base, sessionId, prompt: `check ${i}` });
    }
    const result = await scheduleCheckBack(db, { ...base, sessionId, prompt: "one more" });
    expect("error" in result).toBe(true);
  });

  it("only cancels a check-back from the chat that scheduled it", async () => {
    const mine = await newChat();
    const other = await newChat();
    const result = await scheduleCheckBack(db, { ...base, sessionId: mine, prompt: "x" });
    if ("error" in result) throw new Error(result.error);
    expect(await cancelCheckBack(db, other, result.checkBack.id)).toBe(false);
    expect(await cancelCheckBack(db, mine, result.checkBack.id)).toBe(true);
    expect(await listPendingCheckBacks(db, mine)).toHaveLength(0);
  });
});

describe("claiming", () => {
  it("fires only what is due, and only once", async () => {
    const sessionId = await newChat();
    const now = new Date();
    await scheduleCheckBack(db, { ...base, sessionId, prompt: "soon", delayMinutes: 1 }, now);
    await scheduleCheckBack(db, { ...base, sessionId, prompt: "later", delayMinutes: 60 }, now);
    const later = new Date(now.getTime() + 2 * 60_000);

    const claimed = await claimDueCheckBacks(db, later, 5);
    expect(claimed.map((c) => c.prompt)).toEqual(["soon"]);
    expect(claimed[0]?.status).toBe("fired");
    expect(await claimDueCheckBacks(db, later, 5)).toHaveLength(0);
  });
});

describe("claiming a cancelled check-back", () => {
  it("never fires it", async () => {
    const sessionId = await newChat();
    const now = new Date();
    const result = await scheduleCheckBack(
      db,
      { ...base, sessionId, prompt: "x", delayMinutes: 1 },
      now,
    );
    if ("error" in result) throw new Error(result.error);
    await cancelCheckBack(db, sessionId, result.checkBack.id);
    expect(await claimDueCheckBacks(db, new Date(now.getTime() + 5 * 60_000), 5)).toHaveLength(0);
  });
});

describe("tools", () => {
  it("names only tools that exist in the check-back allowlist", () => {
    const names = Object.keys(builtinToolMetadata());
    expect([...CHECK_BACK_TOOLS].filter((name) => !names.includes(name))).toEqual([]);
  });

  it("carries the turn's model forward and counts the attempt up", async () => {
    const sessionId = await newChat();
    const tools = buildCheckBackTools(db, sessionId, {
      provider: "openai",
      model: "gpt",
      attempt: 3,
    });
    const out = await tools.schedule_check_back.execute!(
      { prompt: "check PR #12's CI", delayMinutes: 5 },
      opts,
    );
    expect(out).toMatchObject({ attempt: 4 });
    const [row] = await listPendingCheckBacks(db, sessionId);
    expect(row).toMatchObject({ provider: "openai", model: "gpt", attempt: 4 });
  });

  it("refuses to schedule outside a chat", async () => {
    const tools = buildCheckBackTools(db, "", { provider: null, model: null, attempt: 0 });
    const out = await tools.schedule_check_back.execute!({ prompt: "x", delayMinutes: 5 }, opts);
    expect(out).toHaveProperty("error");
  });
});

describe("the job", () => {
  async function dueCheckBack(prompt: string) {
    const sessionId = await newChat();
    const result = await scheduleCheckBack(db, { ...base, sessionId, prompt, delayMinutes: 1 });
    if ("error" in result) throw new Error(result.error);
    return result.checkBack;
  }
  const soon = () => ctx(new Date(Date.now() + 2 * 60_000));

  it("skips when nothing is due", async () => {
    const runTurn: CheckBackTurnRunner = async () => ({});
    expect(await checkBacksJob(runTurn).run(soon())).toEqual({ skipped: true });
  });

  it("runs the turn in the scheduling chat and raises the attention it asked for", async () => {
    const checkBack = await dueCheckBack("is CI green?");
    const seen: string[] = [];
    const runTurn: CheckBackTurnRunner = async (input) => {
      seen.push(input.checkBack.sessionId);
      return { attentionReason: "CI is green on #12" };
    };
    await checkBacksJob(runTurn).run(soon());

    expect(seen).toEqual([checkBack.sessionId]);
    const items = await db.select().from(schema.attentionItems);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "info", title: "CI is green on #12" });
  });

  it("raises nothing for a check that is still waiting", async () => {
    await dueCheckBack("is CI green?");
    await checkBacksJob(async () => ({})).run(soon());
    expect(await db.select().from(schema.attentionItems)).toHaveLength(0);
  });

  it("records a failed turn and tells the user", async () => {
    const checkBack = await dueCheckBack("is CI green?");
    await checkBacksJob(async () => {
      throw new Error("provider down");
    }).run(soon());

    const [row] = await db.select().from(schema.chatCheckBacks);
    expect(row).toMatchObject({ id: checkBack.id, status: "fired", error: "provider down" });
    const items = await db.select().from(schema.attentionItems);
    expect(items[0]?.kind).toBe("error");
  });

  it("tells the user when a chain runs out of attempts without an answer", async () => {
    const sessionId = await newChat();
    await scheduleCheckBack(db, {
      ...base,
      sessionId,
      prompt: "last look",
      delayMinutes: 1,
      attempt: MAX_CHECK_BACK_ATTEMPTS,
    });
    await checkBacksJob(async () => ({})).run(soon());
    const items = await db.select().from(schema.attentionItems);
    expect(items[0]?.title).toContain("stopped watching");
  });

  it("runs one chat's check-backs one after another", async () => {
    const sessionId = await newChat();
    for (const prompt of ["first", "second"]) {
      await scheduleCheckBack(db, { ...base, sessionId, prompt, delayMinutes: 1 });
    }
    let running = 0;
    let overlapped = false;
    await checkBacksJob(async () => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return {};
    }).run(soon());
    expect(overlapped).toBe(false);
  });

  it("marks the message as the assistant's own check-back", async () => {
    const checkBack = await dueCheckBack("is CI green?");
    expect(checkBackMessage(checkBack)).toStartWith("[Check-back 1, scheduled ");
    expect(checkBackMessage(checkBack)).toEndWith("\nis CI green?");
  });
});
