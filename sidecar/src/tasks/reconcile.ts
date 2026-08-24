import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Task, tasks, workspaces } from "../db/schema.ts";
import { type EventType, emitEvent, listEvents } from "../events/service.ts";
import { listTasks } from "./service.ts";
import { titleSimilarity } from "./similarity.ts";

/**
 * Noticing that an open task is probably done.
 *
 * Nothing here completes anything: the evidence is handed to the agent, which
 * asks the user. Auto-completing on a guess would quietly erase work the user
 * still means to do, and the signals below are circumstantial — an archived
 * workspace or a merged PR whose title resembles the task.
 */

/** Event types that suggest a piece of work reached its end. */
const COMPLETION_EVENTS: readonly EventType[] = ["pr.merged", "workspace.archived"];

/** How alike an event's subject and a task's title must be to count as evidence. */
const EVIDENCE_THRESHOLD = 0.45;

export interface CompletionEvidence {
  /** What suggests the task is done, in words the agent can relay. */
  reason: string;
  /** Where the signal came from, for the agent to name. */
  source: "workspace" | "event";
  occurredAt: Date;
}

export interface CompletionCandidate {
  task: Task;
  evidence: CompletionEvidence[];
}

/** The strings in an event payload that name what the event was about. */
function eventSubject(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  return [record.name, record.title, record.summary, record.ref, record.key]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export interface ReconcileOptions {
  /** How far back to look for completion signals. Defaults to two weeks. */
  since?: Date;
  /** Cap on events scanned, so a busy log can't make this unbounded. */
  eventLimit?: number;
}

/**
 * Open tasks that look finished, with why. Two signals: the workspace the task
 * was linked to has been archived (strong — archiving is what the user does when
 * the work is done), and a completion event whose subject resembles the task
 * title (weak, hence the threshold and the fact it is only ever a suggestion).
 */
export async function completionCandidates(
  db: Db,
  options: ReconcileOptions = {},
): Promise<CompletionCandidate[]> {
  const openTasks = await listTasks(db, { status: "open" });
  if (openTasks.length === 0) return [];

  const since = options.since ?? new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const byTask = new Map<string, CompletionEvidence[]>();
  const addEvidence = (taskId: string, evidence: CompletionEvidence) => {
    const existing = byTask.get(taskId);
    if (existing) existing.push(evidence);
    else byTask.set(taskId, [evidence]);
  };

  // A task whose workspace is archived: the strongest signal available, and it
  // needs no title matching at all.
  const linkedIds = openTasks.map((t) => t.workspaceId).filter((id): id is string => id !== null);
  if (linkedIds.length) {
    const archived = await db
      .select({ id: workspaces.id, name: workspaces.name, archivedAt: workspaces.archivedAt })
      .from(workspaces)
      .where(and(inArray(workspaces.id, linkedIds), eq(workspaces.status, "archived")));
    const archivedById = new Map(archived.map((w) => [w.id, w]));
    for (const task of openTasks) {
      const workspace = task.workspaceId ? archivedById.get(task.workspaceId) : undefined;
      if (!workspace) continue;
      addEvidence(task.id, {
        reason: `the workspace "${workspace.name}" it was linked to has been archived`,
        source: "workspace",
        occurredAt: workspace.archivedAt ?? since,
      });
    }
  }

  const events = await listEvents(db, {
    types: COMPLETION_EVENTS,
    since,
    limit: options.eventLimit ?? 200,
  });
  for (const event of events) {
    const subject = eventSubject(event.payload);
    if (!subject) continue;
    for (const task of openTasks) {
      if (titleSimilarity(task.title, subject) < EVIDENCE_THRESHOLD) continue;
      addEvidence(task.id, {
        reason: `${event.type} on "${subject}", which reads like this task`,
        source: "event",
        occurredAt: event.occurredAt,
      });
    }
  }

  return openTasks
    .filter((task) => byTask.has(task.id))
    .map((task) => ({ task, evidence: byTask.get(task.id)! }))
    .sort((a, b) => b.evidence.length - a.evidence.length);
}

/**
 * Marks several tasks done in one statement, for a confirmed reconciliation.
 * Each completion is logged like any other, so a reconciled task shows up in the
 * day's summary the same way one the user closed by hand does.
 */
export async function completeTasks(db: Db, ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  const completed = await db
    .update(tasks)
    .set({ status: "done", completedAt: new Date() })
    .where(and(inArray(tasks.id, ids), eq(tasks.status, "open")))
    .returning();
  for (const task of completed) {
    await emitEvent(db, {
      type: "task.completed",
      source: "reconcile",
      payload: { taskId: task.id, title: task.title, scope: task.scope },
    });
  }
  return completed;
}
