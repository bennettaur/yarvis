import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  completeTask,
  createTask,
  deleteTask,
  listTasks,
  rolloverTasks,
  updateTask,
} from "../tasks/service.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/**
 * Task-management tools bound to a database and chat session. The chat model
 * calls these to capture intentions ("I plan to...") and answer recall
 * questions ("what's left to do?").
 */
export function buildTaskTools(db: Db, sessionId: string) {
  return {
    create_task: tool({
      description:
        "Create a task the user intends to do. Use scope 'daily' for work due today and 'weekly' for goals due by the end of the week.",
      inputSchema: z.object({
        title: z.string().describe("Short description of the task"),
        scope: z.enum(["daily", "weekly"]),
        targetDate: isoDate.optional().describe("Due date; for weekly goals, the end-of-week date"),
      }),
      execute: async ({ title, scope, targetDate }) => {
        const t = await createTask(db, {
          title,
          scope,
          targetDate: targetDate ?? null,
          sourceSessionId: sessionId,
        });
        return { id: t.id, title: t.title, scope: t.scope, targetDate: t.targetDate };
      },
    }),

    list_tasks: tool({
      description:
        "List the user's tasks, optionally filtered by status, scope, or exact target date.",
      inputSchema: z.object({
        status: z.enum(["open", "done"]).optional(),
        scope: z.enum(["daily", "weekly"]).optional(),
        targetDate: isoDate.optional(),
      }),
      execute: async (filter) => {
        const tasks = await listTasks(db, filter);
        return tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          scope: t.scope,
          targetDate: t.targetDate,
        }));
      },
    }),

    complete_task: tool({
      description: "Mark a task done by its id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const t = await completeTask(db, id);
        return t ? { id: t.id, status: t.status } : { error: "not found" };
      },
    }),

    update_task: tool({
      description: "Update a task's title, scope, status, or target date.",
      inputSchema: z.object({
        id: z.string(),
        title: z.string().optional(),
        scope: z.enum(["daily", "weekly"]).optional(),
        status: z.enum(["open", "done"]).optional(),
        targetDate: isoDate.nullable().optional(),
      }),
      execute: async ({ id, ...patch }) => {
        const t = await updateTask(db, id, patch);
        return t ? { id: t.id } : { error: "not found" };
      },
    }),

    delete_task: tool({
      description:
        "Permanently delete a task by its id. Use when a task was captured by mistake or is no longer relevant; prefer complete_task for work that actually got done.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const t = await deleteTask(db, id);
        return t ? { id: t.id, deleted: true } : { error: "not found" };
      },
    }),

    rollover_tasks: tool({
      description:
        "Move still-open tasks from one date to another, e.g. roll yesterday's unfinished work into today.",
      inputSchema: z.object({ fromDate: isoDate, toDate: isoDate }),
      execute: async ({ fromDate, toDate }) => {
        const moved = await rolloverTasks(db, fromDate, toDate);
        return { moved: moved.length };
      },
    }),
  };
}
