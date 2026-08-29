import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { createTodo, deleteTodo, getTodo, listTodos, updateTodo } from "./service.ts";

/**
 * The agent's own todo tools. Not registered on the MCP endpoint: this is the
 * in-app assistant's working state, and a Claude Code session writing to it
 * would be one agent rewriting another's plan.
 */

const uuid = z.string().uuid();
const priority = z.enum(["urgent", "high", "medium", "low"]);
const status = z.enum(["pending", "in_progress", "blocked", "done", "wont_do"]);

/** A date-time the model can express without a timezone argument. */
const dueAt = z
  .string()
  .datetime({ offset: true })
  .describe("When this needs to be done by, as an ISO timestamp");

export function buildTodoTools(db: Db) {
  return {
    create_todo: tool({
      description:
        "Add something to YOUR OWN todo list — work you have taken on, not something the user is going to do (use create_task for that). Use it when you commit to following up: preparing for a meeting, checking back on a PR, drafting something before a deadline.",
      inputSchema: z.object({
        title: z.string().min(1).max(500),
        details: z.string().max(4000).optional().describe("What doing this involves"),
        priority: priority.optional(),
        projectId: uuid.optional().describe("Project this serves, if any"),
        dueAt: dueAt.optional(),
      }),
      execute: async ({ title, details, priority: p, projectId, dueAt: due }) => {
        const todo = await createTodo(db, {
          title,
          details,
          priority: p,
          projectId,
          dueAt: due ? new Date(due) : null,
        });
        return { id: todo.id, title: todo.title, priority: todo.priority, status: todo.status };
      },
    }),

    list_todos: tool({
      description:
        "Your own todo list. Defaults to what is still live (pending, in progress, blocked), most urgent first. Read this at the start of a planning turn so you pick up what you already committed to.",
      inputSchema: z.object({
        statuses: z.array(status).optional().describe("Defaults to the open ones"),
        projectId: uuid.optional(),
        dueBy: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("Only todos due by then (undated ones are always included)"),
      }),
      execute: async ({ statuses, projectId, dueBy }) => {
        const todos = await listTodos(db, {
          statuses,
          projectId,
          dueBy: dueBy ? new Date(dueBy) : undefined,
        });
        return todos.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueAt: t.dueAt?.toISOString() ?? null,
          projectId: t.projectId,
          noteCount: t.notes.length,
        }));
      },
    }),

    get_todo: tool({
      description: "One of your todos in full, including its progress notes.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const todo = await getTodo(db, id);
        if (!todo) return { error: "no todo with that id" };
        return {
          id: todo.id,
          title: todo.title,
          details: todo.details,
          status: todo.status,
          priority: todo.priority,
          dueAt: todo.dueAt?.toISOString() ?? null,
          notes: todo.notes,
        };
      },
    }),

    update_todo: tool({
      description:
        "Move one of your todos along: change its status ('in_progress' when you start, 'blocked' when you can't proceed, 'done' when finished, 'wont_do' when you decide against it), adjust its priority or deadline, or append a progress note. Notes accumulate — each call adds one rather than replacing the log.",
      inputSchema: z.object({
        id: uuid,
        status: status.optional(),
        priority: priority.optional(),
        title: z.string().min(1).max(500).optional(),
        details: z.string().max(4000).optional(),
        dueAt: dueAt.optional(),
        note: z.string().max(2000).optional().describe("Appended to the progress log"),
      }),
      execute: async ({ id, dueAt: due, ...patch }) => {
        const todo = await updateTodo(db, id, {
          ...patch,
          ...(due !== undefined ? { dueAt: new Date(due) } : {}),
        });
        return todo
          ? { id: todo.id, status: todo.status, priority: todo.priority }
          : { error: "no todo with that id" };
      },
    }),

    delete_todo: tool({
      description:
        "Permanently remove one of your todos. Prefer update_todo with status 'wont_do' when you decided against it — that keeps the reasoning.",
      inputSchema: z.object({ id: uuid }),
      execute: async ({ id }) => {
        const deleted = await deleteTodo(db, id);
        return deleted ? { id, deleted: true } : { error: "no todo with that id" };
      },
    }),
  };
}
