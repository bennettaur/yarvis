import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { tasks, type Task } from "../db/schema.ts";

/**
 * Work-tracking task service. Tasks are daily or weekly, open or done, and may
 * carry a target date. The chat model drives these via tool-calls (M1c), and
 * the Tasks UI reads/writes them directly.
 */

export interface CreateTaskInput {
  title: string;
  scope: "daily" | "weekly";
  /** ISO date "YYYY-MM-DD". */
  targetDate?: string | null;
  notes?: string | null;
  sourceSessionId?: string | null;
}

export interface TaskFilter {
  status?: "open" | "done";
  scope?: "daily" | "weekly";
  /** Exact ISO date match "YYYY-MM-DD". */
  targetDate?: string;
}

export interface UpdateTaskInput {
  title?: string;
  scope?: "daily" | "weekly";
  status?: "open" | "done";
  targetDate?: string | null;
  notes?: string | null;
}

export async function createTask(
  db: Db,
  input: CreateTaskInput,
): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      title: input.title,
      scope: input.scope,
      targetDate: input.targetDate ?? null,
      notes: input.notes ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
    })
    .returning();
  return row!;
}

export async function listTasks(
  db: Db,
  filter: TaskFilter = {},
): Promise<Task[]> {
  const conditions = [];
  if (filter.status) conditions.push(eq(tasks.status, filter.status));
  if (filter.scope) conditions.push(eq(tasks.scope, filter.scope));
  if (filter.targetDate) conditions.push(eq(tasks.targetDate, filter.targetDate));

  return db
    .select()
    .from(tasks)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(tasks.scope), asc(tasks.targetDate), asc(tasks.createdAt));
}

/**
 * Tasks completed within an inclusive instant range, used by recaps. Ordered
 * by when they were finished.
 */
export async function tasksCompletedBetween(
  db: Db,
  from: Date,
  to: Date,
): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.completedAt),
        gte(tasks.completedAt, from),
        lte(tasks.completedAt, to),
      ),
    )
    .orderBy(asc(tasks.completedAt));
}

export async function completeTask(
  db: Db,
  id: string,
): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  return row ?? null;
}

export async function updateTask(
  db: Db,
  id: string,
  patch: UpdateTaskInput,
): Promise<Task | null> {
  // Clearing the completion timestamp when a task is reopened keeps state honest.
  const values: Partial<typeof tasks.$inferInsert> = { ...patch };
  if (patch.status === "open") values.completedAt = null;
  if (patch.status === "done") values.completedAt = new Date();

  const [row] = await db
    .update(tasks)
    .set(values)
    .where(eq(tasks.id, id))
    .returning();
  return row ?? null;
}

/**
 * Moves still-open tasks from one target date to another (e.g. rolling
 * yesterday's unfinished work into today). Returns the updated tasks.
 */
export async function rolloverTasks(
  db: Db,
  fromDate: string,
  toDate: string,
): Promise<Task[]> {
  return db
    .update(tasks)
    .set({ targetDate: toDate })
    .where(and(eq(tasks.status, "open"), eq(tasks.targetDate, fromDate)))
    .returning();
}
