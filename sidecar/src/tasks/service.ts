import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Task, tasks } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { DUPLICATE_THRESHOLD, SIMILAR_THRESHOLD, titleSimilarity } from "./similarity.ts";

/** Payload shared by task.created / task.completed events. */
function taskEventPayload(task: Task): Record<string, unknown> {
  return { taskId: task.id, title: task.title, scope: task.scope };
}

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
  /** Project the task serves, when the user named one. */
  projectId?: string | null;
}

export interface TaskFilter {
  status?: "open" | "done";
  scope?: "daily" | "weekly";
  /** Exact ISO date match "YYYY-MM-DD". */
  targetDate?: string;
  projectId?: string;
}

export interface UpdateTaskInput {
  title?: string;
  scope?: "daily" | "weekly";
  status?: "open" | "done";
  targetDate?: string | null;
  notes?: string | null;
  projectId?: string | null;
}

export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
  const [row] = await db
    .insert(tasks)
    .values({
      title: input.title,
      scope: input.scope,
      targetDate: input.targetDate ?? null,
      notes: input.notes ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      projectId: input.projectId ?? null,
    })
    .returning();
  await emitEvent(db, {
    type: "task.created",
    source: "tasks",
    payload: taskEventPayload(row!),
  });
  return row!;
}

export async function listTasks(db: Db, filter: TaskFilter = {}): Promise<Task[]> {
  const conditions = [];
  if (filter.status) conditions.push(eq(tasks.status, filter.status));
  if (filter.scope) conditions.push(eq(tasks.scope, filter.scope));
  if (filter.targetDate) conditions.push(eq(tasks.targetDate, filter.targetDate));
  if (filter.projectId) conditions.push(eq(tasks.projectId, filter.projectId));

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
export async function tasksCompletedBetween(db: Db, from: Date, to: Date): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(
      and(isNotNull(tasks.completedAt), gte(tasks.completedAt, from), lte(tasks.completedAt, to)),
    )
    .orderBy(asc(tasks.completedAt));
}

/** Tasks linked to a workspace (oldest first), for the workspace detail view. */
export async function tasksForWorkspace(db: Db, workspaceId: string): Promise<Task[]> {
  return db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, workspaceId))
    .orderBy(asc(tasks.createdAt));
}

/**
 * Completes every still-open task linked to a workspace. Used when a workspace
 * is archived after its PR merged. Returns the tasks that were closed.
 */
export async function completeTasksByWorkspace(db: Db, workspaceId: string): Promise<Task[]> {
  return db
    .update(tasks)
    .set({ status: "done", completedAt: new Date() })
    .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, "open")))
    .returning();
}

export async function completeTask(db: Db, id: string): Promise<Task | null> {
  const [row] = await db
    .update(tasks)
    .set({ status: "done", completedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning();
  if (row) {
    await emitEvent(db, {
      type: "task.completed",
      source: "tasks",
      payload: taskEventPayload(row),
    });
  }
  return row ?? null;
}

export async function updateTask(db: Db, id: string, patch: UpdateTaskInput): Promise<Task | null> {
  // Clearing the completion timestamp when a task is reopened keeps state honest.
  const values: Partial<typeof tasks.$inferInsert> = { ...patch };
  if (patch.status === "open") values.completedAt = null;
  if (patch.status === "done") values.completedAt = new Date();

  const [row] = await db.update(tasks).set(values).where(eq(tasks.id, id)).returning();
  // Mirror completeTask: a task moving to "done" via an edit is a completion too.
  if (row && patch.status === "done") {
    await emitEvent(db, {
      type: "task.completed",
      source: "tasks",
      payload: taskEventPayload(row),
    });
  }
  return row ?? null;
}

/**
 * Permanently removes a task. Returns the deleted row, or null if no task
 * matched the id. Unlike completion, this leaves no trace in the event log —
 * a removed task was never meant to be tracked.
 */
export async function deleteTask(db: Db, id: string): Promise<Task | null> {
  const [row] = await db.delete(tasks).where(eq(tasks.id, id)).returning();
  return row ?? null;
}

/**
 * Moves still-open tasks from one target date to another (e.g. rolling
 * yesterday's unfinished work into today). Returns the updated tasks.
 */
export async function rolloverTasks(db: Db, fromDate: string, toDate: string): Promise<Task[]> {
  const moved = await db
    .update(tasks)
    .set({ targetDate: toDate })
    .where(and(eq(tasks.status, "open"), eq(tasks.targetDate, fromDate)))
    .returning();
  if (moved.length > 0) {
    await emitEvent(db, {
      type: "task.rolled_over",
      source: "tasks",
      payload: { fromDate, toDate, count: moved.length },
    });
  }
  return moved;
}

export interface SimilarTask {
  task: Task;
  /** Title overlap, 0–1. */
  score: number;
}

/**
 * Open tasks whose titles resemble `title`, most alike first. The agent calls
 * this before capturing an intention so a restated plan updates the task it
 * already has instead of stacking a second one.
 *
 * Ranking happens in memory over the user's open tasks — a personal list, tens
 * of rows, not thousands — which keeps the comparison out of SQL and makes the
 * threshold behaviour testable without a database.
 */
export async function findSimilarTasks(
  db: Db,
  title: string,
  options: { threshold?: number; limit?: number; includeDone?: boolean } = {},
): Promise<SimilarTask[]> {
  const candidates = await listTasks(db, options.includeDone ? {} : { status: "open" });
  return candidates
    .map((task) => ({ task, score: titleSimilarity(title, task.title) }))
    .filter((match) => match.score >= (options.threshold ?? SIMILAR_THRESHOLD))
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5);
}

export interface CreateTaskResult {
  task: Task;
  /** Set when an existing task matched closely enough to reuse instead. */
  duplicateOf?: Task;
  /** Near-misses worth mentioning even when a task was created. */
  similar: SimilarTask[];
}

/**
 * Captures an intention, reusing an existing open task when one says the same
 * thing. Returning the near-misses either way is deliberate: the agent can tell
 * the user "you already have that" without a second round-trip, and a match that
 * was close but under the bar is still worth mentioning.
 */
export async function createTaskDeduped(
  db: Db,
  input: CreateTaskInput,
  threshold: number = DUPLICATE_THRESHOLD,
): Promise<CreateTaskResult> {
  const similar = await findSimilarTasks(db, input.title);
  const duplicate = similar.find((match) => match.score >= threshold);
  if (duplicate) {
    return { task: duplicate.task, duplicateOf: duplicate.task, similar };
  }
  return { task: await createTask(db, input), similar };
}
