import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { builtinToolMetadata } from "../chat/builtinTools.ts";
import { SCHEDULED_TASK_TOOLS } from "../chat/destructiveTools.ts";
import { createSession } from "../chat/service.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import type { JobContext } from "../jobs/scheduler.ts";
import { type ScheduledTaskTurnRunner, scheduledTaskMessage, scheduledTasksJob } from "./job.ts";
import {
  cancelScheduledTask,
  claimDueScheduledTasks,
  listPendingScheduledTasks,
  MAX_PENDING_PER_SESSION,
  MAX_SCHEDULED_TASK_ATTEMPTS,
  scheduleTask,
} from "./service.ts";
import { buildScheduledTaskTools } from "./tools.ts";

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

const base = {
  title: "Check PRs",
  origin: "chat" as "chat" | "heads-down",
  provider: "anthropic",
  model: "claude",
  attempt: 1,
  delayMinutes: 10,
  parentId: null as string | null,
};

async function newChat(): Promise<string> {
  return (await createSession(db)).id;
}

function ctx(now: Date): JobContext {
  return { db, config, cursor: null, now, trigger: "schedule" };
}

async function schedule(input: Partial<typeof base> & { sessionId: string; prompt?: string }) {
  const result = await scheduleTask(db, { ...base, prompt: "are my PRs mergeable?", ...input });
  if ("error" in result) throw new Error(result.error);
  return result.scheduledTask;
}

describe("scheduling", () => {
  it("stores a task due after the delay", async () => {
    const sessionId = await newChat();
    const now = new Date("2026-10-16T12:00:00Z");
    const result = await scheduleTask(db, { ...base, sessionId, prompt: "check in" }, now);
    if ("error" in result) throw new Error(result.error);
    expect(result.scheduledTask.dueAt.toISOString()).toBe("2026-10-16T12:10:00.000Z");
    expect(result.scheduledTask.status).toBe("pending");
  });

  it("accepts the last run of a chain and refuses the one after", async () => {
    const sessionId = await newChat();
    await schedule({ sessionId, attempt: MAX_SCHEDULED_TASK_ATTEMPTS });
    const result = await scheduleTask(db, {
      ...base,
      sessionId,
      prompt: "again",
      attempt: MAX_SCHEDULED_TASK_ATTEMPTS + 1,
    });
    expect(result).toEqual({ error: expect.stringContaining("already run") });
  });

  it("refuses to re-check a chain sooner than the floor", async () => {
    const sessionId = await newChat();
    const parent = await schedule({ sessionId });
    const result = await scheduleTask(db, {
      ...base,
      sessionId,
      prompt: "again",
      attempt: 2,
      parentId: parent.id,
      delayMinutes: 1,
    });
    expect(result).toEqual({ error: expect.stringContaining("at least") });
  });

  it("caps how many one chat can have waiting", async () => {
    const sessionId = await newChat();
    for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) {
      await schedule({ sessionId, prompt: `task ${i}` });
    }
    const result = await scheduleTask(db, { ...base, sessionId, prompt: "one more" });
    expect(result).toEqual({ error: expect.stringContaining("pending scheduled tasks") });
  });

  it("only cancels a task from the chat that scheduled it", async () => {
    const mine = await newChat();
    const other = await newChat();
    const task = await schedule({ sessionId: mine });
    expect(await cancelScheduledTask(db, other, task.id)).toBe(false);
    expect(await cancelScheduledTask(db, mine, task.id)).toBe(true);
    expect(await listPendingScheduledTasks(db, mine)).toHaveLength(0);
  });
});

describe("claiming", () => {
  it("fires only what is due, and only once", async () => {
    const sessionId = await newChat();
    const now = new Date();
    await scheduleTask(db, { ...base, sessionId, prompt: "soon", delayMinutes: 1 }, now);
    await scheduleTask(db, { ...base, sessionId, prompt: "later", delayMinutes: 60 }, now);
    const later = new Date(now.getTime() + 2 * 60_000);

    const claimed = await claimDueScheduledTasks(db, later, 5);
    expect(claimed.map((c) => c.prompt)).toEqual(["soon"]);
    expect(claimed[0]?.status).toBe("fired");
    expect(await claimDueScheduledTasks(db, later, 5)).toHaveLength(0);
  });

  it("never fires a cancelled task", async () => {
    const sessionId = await newChat();
    const task = await schedule({ sessionId, delayMinutes: 1 });
    await cancelScheduledTask(db, sessionId, task.id);
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await claimDueScheduledTasks(db, later, 5)).toHaveLength(0);
  });
});

describe("tools", () => {
  it("names only tools that exist in the scheduled-task allowlist", () => {
    const names = Object.keys(builtinToolMetadata());
    expect([...SCHEDULED_TASK_TOOLS].filter((name) => !names.includes(name))).toEqual([]);
  });

  it("carries the turn's model and origin forward and counts the attempt up", async () => {
    const sessionId = await newChat();
    const tools = buildScheduledTaskTools(db, sessionId, {
      provider: "openai",
      model: "gpt",
      attempt: 3,
      scheduledTaskId: null,
      origin: "heads-down",
    });
    const out = await tools.schedule_task.execute?.(
      { title: "Check CI", prompt: "check PR #12's CI", delayMinutes: 5 },
      opts,
    );
    expect(out).toMatchObject({ attempt: 4 });
    const [row] = await listPendingScheduledTasks(db, sessionId);
    expect(row).toMatchObject({
      title: "Check CI",
      provider: "openai",
      model: "gpt",
      attempt: 4,
      origin: "heads-down",
    });
  });

  it("refuses to schedule outside a chat", async () => {
    const tools = buildScheduledTaskTools(db, "", {
      provider: null,
      model: null,
      attempt: 0,
      scheduledTaskId: null,
      origin: "chat",
    });
    const out = await tools.schedule_task.execute?.(
      { title: "x", prompt: "x", delayMinutes: 5 },
      opts,
    );
    expect(out).toHaveProperty("error");
  });
});

describe("the job", () => {
  const soon = () => ctx(new Date(Date.now() + 2 * 60_000));
  const attentionItems = () => db.select().from(schema.attentionItems);

  it("skips when nothing is due", async () => {
    const runTurn: ScheduledTaskTurnRunner = async () => ({});
    expect(await scheduledTasksJob(runTurn).run(soon())).toEqual({ skipped: true });
  });

  it("runs the turn in the scheduling chat and rings the bell with a link to it", async () => {
    const task = await schedule({ sessionId: await newChat(), delayMinutes: 1 });
    const seen: string[] = [];
    await scheduledTasksJob(async (input) => {
      seen.push(input.scheduledTask.sessionId);
      return { reply: "Two of your three PRs are mergeable; #14 has a failing check." };
    }).run(soon());

    expect(seen).toEqual([task.sessionId]);
    const [item] = await attentionItems();
    expect(item).toMatchObject({
      kind: "info",
      title: "Yarvis · Check PRs",
      body: "Two of your three PRs are mergeable; #14 has a failing check.",
      navTarget: { type: "chat", sessionId: task.sessionId },
    });
  });

  it("keeps the title its own and puts the model's words in the body", async () => {
    await schedule({ sessionId: await newChat(), delayMinutes: 1 });
    await scheduledTasksJob(async () => ({
      attentionReason: "Security alert:\nre-authenticate now",
    })).run(soon());
    const [item] = await attentionItems();
    expect(item).toMatchObject({
      title: "Yarvis · Check PRs",
      body: "Security alert: re-authenticate now",
    });
  });

  it("sends a heads-down pass's task to the Heads down page", async () => {
    await schedule({ sessionId: await newChat(), delayMinutes: 1, origin: "heads-down" });
    await scheduledTasksJob(async () => ({ reply: "done" })).run(soon());
    const [item] = await attentionItems();
    expect(item?.navTarget).toEqual({ type: "heads-down" });
  });

  it("stays quiet when a run only scheduled its next one", async () => {
    const task = await schedule({ sessionId: await newChat(), delayMinutes: 1 });
    await scheduledTasksJob(async () => {
      await scheduleTask(db, {
        ...base,
        sessionId: task.sessionId,
        prompt: "x",
        attempt: 2,
        parentId: task.id,
      });
      return { reply: "Still running." };
    }).run(soon());
    expect(await attentionItems()).toHaveLength(0);
  });

  it("still reports a task whose sibling in the same chat rescheduled itself", async () => {
    const sessionId = await newChat();
    const watcher = await schedule({ sessionId, title: "Watch CI", delayMinutes: 1 });
    await schedule({ sessionId, title: "Goals check-in", delayMinutes: 1 });
    await scheduledTasksJob(async ({ scheduledTask }) => {
      if (scheduledTask.id === watcher.id) {
        await scheduleTask(db, {
          ...base,
          sessionId,
          prompt: "x",
          attempt: 2,
          parentId: watcher.id,
        });
        return { reply: "Still running." };
      }
      return { reply: "Two of three goals are on track." };
    }).run(soon());
    const items = await attentionItems();
    expect(items.map((item) => item.title)).toEqual(["Yarvis · Goals check-in"]);
  });

  it("records a failed turn and tells the user", async () => {
    const task = await schedule({ sessionId: await newChat(), delayMinutes: 1 });
    await scheduledTasksJob(async () => {
      throw new Error("provider down");
    }).run(soon());

    const [row] = await db.select().from(schema.chatScheduledTasks);
    expect(row).toMatchObject({ id: task.id, status: "fired", error: "provider down" });
    const [item] = await attentionItems();
    expect(item).toMatchObject({
      kind: "error",
      title: "Yarvis · scheduled task failed: Check PRs",
      navTarget: { type: "chat", sessionId: task.sessionId },
    });
  });

  it("says so when a chain runs out of runs", async () => {
    await schedule({
      sessionId: await newChat(),
      delayMinutes: 1,
      attempt: MAX_SCHEDULED_TASK_ATTEMPTS,
    });
    await scheduledTasksJob(async () => ({ reply: "still waiting" })).run(soon());
    const [item] = await attentionItems();
    expect(item?.title).toContain(`stopped after ${MAX_SCHEDULED_TASK_ATTEMPTS} runs`);
  });

  it("runs one chat's tasks one after another", async () => {
    const sessionId = await newChat();
    for (const prompt of ["first", "second"]) {
      await schedule({ sessionId, prompt, delayMinutes: 1 });
    }
    let running = 0;
    let overlapped = false;
    await scheduledTasksJob(async () => {
      running++;
      if (running > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return {};
    }).run(soon());
    expect(overlapped).toBe(false);
  });
});

describe("the stored message", () => {
  it("names the task and marks it as the assistant's own", async () => {
    const task = await schedule({ sessionId: await newChat(), prompt: "are my PRs mergeable?" });
    expect(scheduledTaskMessage(task)).toStartWith("[Scheduled task: Check PRs, scheduled ");
    expect(scheduledTaskMessage(task)).toEndWith("\nare my PRs mergeable?");
  });
});
