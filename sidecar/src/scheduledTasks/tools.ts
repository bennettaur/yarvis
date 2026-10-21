import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { ChatScheduledTask } from "../db/schema.ts";
import {
  cancelScheduledTask,
  listPendingScheduledTasks,
  MAX_DELAY_MINUTES,
  MAX_PROMPT_CHARS,
  MAX_SCHEDULED_TASK_ATTEMPTS,
  MAX_TITLE_CHARS,
  MIN_DELAY_MINUTES,
  scheduleTask,
} from "./service.ts";

/** What a turn knows that a task it schedules has to carry forward. */
export interface ScheduledTaskTurnContext {
  /** The provider/model this turn runs on, so the task runs on the same one. */
  provider: string | null;
  model: string | null;
  /** The attempt this turn is running, or 0 when it isn't a scheduled task's turn. */
  attempt: number;
  /** Where a task scheduled from this turn reports back. */
  origin: ChatScheduledTask["origin"];
}

export function buildScheduledTaskTools(db: Db, sessionId: string, turn: ScheduledTaskTurnContext) {
  return {
    schedule_task: tool({
      description: `Leave yourself a prompt to run later in this same chat. Use it to check on something that takes time (CI finishing, PRs becoming mergeable, a workspace session getting somewhere) or to come back at a useful moment (a mid-week check-in on the goals the user set on Monday). Write the prompt in your own words: what to look at, with which tool and ids, and what to tell the user. When it runs, the user gets a notification that you have something for them. A task watching something unfinished can schedule the next one; a chain stops after ${MAX_SCHEDULED_TASK_ATTEMPTS} runs. The future turn runs unattended with read-only tools: it can look things up, report and schedule another task, but it cannot start sessions, write tasks or memories, or use external (MCP) tools. Pick a delay that fits how fast the thing changes rather than the shortest one.`,
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_CHARS)
          .describe(
            "A few words naming the task, shown in the notification, e.g. 'Check PR status'",
          ),
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe(
            "Self-contained instructions for your future turn: what to look at, with which tool and ids, and what to report",
          ),
        delayMinutes: z
          .number()
          .int()
          .min(MIN_DELAY_MINUTES)
          .max(MAX_DELAY_MINUTES)
          .describe("How long from now to run it"),
      }),
      execute: async ({ title, prompt, delayMinutes }) => {
        // A delegated specialist runs with no session. NEVER_DELEGATABLE already keeps
        // these tools from it; this stops a row being written if that ever changes.
        if (!sessionId) return { error: "there is no chat to come back to from here" };
        const result = await scheduleTask(db, {
          sessionId,
          title,
          prompt,
          delayMinutes,
          origin: turn.origin,
          provider: turn.provider,
          model: turn.model,
          attempt: turn.attempt + 1,
        });
        if ("error" in result) return result;
        return {
          id: result.scheduledTask.id,
          dueAt: result.scheduledTask.dueAt.toISOString(),
          attempt: result.scheduledTask.attempt,
        };
      },
    }),

    list_scheduled_tasks: tool({
      description: "List the tasks still waiting to run in this chat, soonest first.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!sessionId) return { scheduledTasks: [] };
        const rows = await listPendingScheduledTasks(db, sessionId);
        return {
          scheduledTasks: rows.map((row) => ({
            id: row.id,
            title: row.title,
            prompt: row.prompt,
            dueAt: row.dueAt.toISOString(),
            attempt: row.attempt,
          })),
        };
      },
    }),

    cancel_scheduled_task: tool({
      description:
        "Cancel a pending scheduled task in this chat, for example when the user says to stop watching something or skip a check-in. Get the id from list_scheduled_tasks.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        if (!sessionId) return { cancelled: false };
        return { cancelled: await cancelScheduledTask(db, sessionId, id) };
      },
    }),
  };
}
