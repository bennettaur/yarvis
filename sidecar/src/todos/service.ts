import { and, asc, eq, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type AgentTodo, type AgentTodoNote, agentTodos } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

/**
 * The assistant's own todo list.
 *
 * This is not the user's `tasks` table: these are things the *agent* has taken
 * on — "draft the demo script before Thursday's review", "check whether that PR
 * ever got merged" — so it can carry state between conversations instead of
 * re-deriving its intentions every turn. Kept separate so the user's daily list
 * never fills up with the assistant's bookkeeping, and deliberately not exposed
 * over the MCP endpoint, where a Claude Code session would be one agent editing
 * another's plan.
 */

/** Statuses that mean the todo is still live, for the default listing. */
export const OPEN_TODO_STATUSES = ["pending", "in_progress", "blocked"] as const;

export interface CreateTodoInput {
  title: string;
  details?: string | null;
  priority?: AgentTodo["priority"];
  projectId?: string | null;
  dueAt?: Date | null;
}

export interface UpdateTodoInput {
  title?: string;
  details?: string | null;
  status?: AgentTodo["status"];
  priority?: AgentTodo["priority"];
  projectId?: string | null;
  dueAt?: Date | null;
  /** Appended to the progress log rather than replacing it. */
  note?: string;
}

export interface ListTodosOptions {
  statuses?: readonly AgentTodo["status"][];
  projectId?: string;
  /** Only todos due at or before this instant (or with no due date at all). */
  dueBy?: Date;
}

export async function createTodo(db: Db, input: CreateTodoInput): Promise<AgentTodo> {
  const [row] = await db
    .insert(agentTodos)
    .values({
      title: input.title.trim(),
      details: input.details ?? null,
      priority: input.priority ?? "medium",
      projectId: input.projectId ?? null,
      dueAt: input.dueAt ?? null,
    })
    .returning();
  await emitEvent(db, {
    type: "todo.created",
    source: "todos",
    payload: { todoId: row!.id, title: row!.title, priority: row!.priority },
  });
  return row!;
}

export async function getTodo(db: Db, id: string): Promise<AgentTodo | null> {
  const [row] = await db.select().from(agentTodos).where(eq(agentTodos.id, id));
  return row ?? null;
}

/** Live todos first, most urgent first, then soonest due. */
export async function listTodos(db: Db, options: ListTodosOptions = {}): Promise<AgentTodo[]> {
  const conditions: SQL[] = [];
  const statuses = options.statuses ?? OPEN_TODO_STATUSES;
  if (statuses.length) conditions.push(inArray(agentTodos.status, [...statuses]));
  if (options.projectId) conditions.push(eq(agentTodos.projectId, options.projectId));
  if (options.dueBy) {
    // A todo with no due date is never excluded by a deadline filter: "what is
    // due this week" should still surface the undated work it can do now.
    const dueClause = or(isNull(agentTodos.dueAt), lte(agentTodos.dueAt, options.dueBy));
    if (dueClause) conditions.push(dueClause);
  }
  return db
    .select()
    .from(agentTodos)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(agentTodos.priority), asc(agentTodos.dueAt), asc(agentTodos.createdAt));
}

/** Appends to the progress log without rewriting what is already there. */
function appendNote(existing: AgentTodoNote[], note: string, at: Date): AgentTodoNote[] {
  return [...existing, { at: at.toISOString(), text: note }];
}

/** Statuses that close a todo out, so `closedAt` is set once and not re-stamped. */
const CLOSED_STATUSES: readonly AgentTodo["status"][] = ["done", "wont_do"];

export async function updateTodo(
  db: Db,
  id: string,
  patch: UpdateTodoInput,
): Promise<AgentTodo | null> {
  const existing = await getTodo(db, id);
  if (!existing) return null;
  const now = new Date();
  const closing = patch.status !== undefined && CLOSED_STATUSES.includes(patch.status);
  const reopening =
    patch.status !== undefined && !closing && CLOSED_STATUSES.includes(existing.status);

  const [row] = await db
    .update(agentTodos)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.details !== undefined ? { details: patch.details } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      ...(patch.note ? { notes: appendNote(existing.notes, patch.note, now) } : {}),
      ...(closing ? { closedAt: now } : {}),
      ...(reopening ? { closedAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(agentTodos.id, id))
    .returning();

  if (row) {
    await emitEvent(db, {
      type: closing ? "todo.closed" : "todo.updated",
      source: "todos",
      payload: { todoId: row.id, title: row.title, status: row.status },
    });
  }
  return row ?? null;
}

export async function deleteTodo(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(agentTodos)
    .where(eq(agentTodos.id, id))
    .returning({ id: agentTodos.id });
  return deleted.length > 0;
}
