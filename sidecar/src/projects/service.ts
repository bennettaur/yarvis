import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type Project,
  type ProjectItem,
  projectItems,
  projects,
  type Task,
  tasks,
} from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

/**
 * Projects: the durable handle for a body of work the user has told the
 * assistant about. Everything here is structured state the planner queries —
 * which projects are active, which tickets belong to them and how urgent each
 * is. The narrative (what was decided, what changed) lives in memory with a
 * `project` source ref, because that is prose to recall, not rows to filter.
 */

export interface CreateProjectInput {
  name: string;
  summary?: string | null;
  focus?: string | null;
  repoIds?: string[];
}

export interface UpdateProjectInput {
  name?: string;
  status?: Project["status"];
  summary?: string | null;
  focus?: string | null;
  repoIds?: string[];
}

/**
 * Finds a project by name, case-insensitively — the agent resolves a project
 * from what the user said, and they don't capitalize consistently.
 */
export async function findProjectByName(db: Db, name: string): Promise<Project | null> {
  const [row] = await db
    .select()
    .from(projects)
    .where(sql`lower(${projects.name}) = lower(${name.trim()})`);
  return row ?? null;
}

export async function getProject(db: Db, id: string): Promise<Project | null> {
  const [row] = await db.select().from(projects).where(eq(projects.id, id));
  return row ?? null;
}

export async function listProjects(
  db: Db,
  options: { status?: Project["status"] } = {},
): Promise<Project[]> {
  return db
    .select()
    .from(projects)
    .where(options.status ? eq(projects.status, options.status) : undefined)
    .orderBy(desc(projects.updatedAt));
}

/**
 * Creates a project, or returns the existing one when the name is already taken.
 * Idempotent on purpose: the agent resolves a project by name every turn, and a
 * duplicate-name failure there would surface to the user as a broken tool rather
 * than "you already have that project".
 */
export async function upsertProject(
  db: Db,
  input: CreateProjectInput,
): Promise<{ project: Project; created: boolean }> {
  const name = input.name.trim();
  const existing = await findProjectByName(db, name);
  if (existing) {
    const patch: UpdateProjectInput = {};
    // Only fill gaps: an existing project's own summary/focus is more current
    // than whatever a fresh create call happened to pass.
    if (input.summary && !existing.summary) patch.summary = input.summary;
    if (input.focus && !existing.focus) patch.focus = input.focus;
    if (input.repoIds?.length && existing.repoIds.length === 0) patch.repoIds = input.repoIds;
    const project = Object.keys(patch).length
      ? ((await updateProject(db, existing.id, patch)) ?? existing)
      : existing;
    return { project, created: false };
  }

  const [row] = await db
    .insert(projects)
    .values({
      name,
      summary: input.summary ?? null,
      focus: input.focus ?? null,
      repoIds: input.repoIds ?? [],
    })
    .returning();
  await emitEvent(db, {
    type: "project.created",
    source: "projects",
    payload: { projectId: row!.id, name: row!.name },
  });
  return { project: row!, created: true };
}

export async function updateProject(
  db: Db,
  id: string,
  patch: UpdateProjectInput,
): Promise<Project | null> {
  const [row] = await db
    .update(projects)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.focus !== undefined ? { focus: patch.focus } : {}),
      ...(patch.repoIds !== undefined ? { repoIds: patch.repoIds } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id))
    .returning();
  if (row) {
    await emitEvent(db, {
      type: "project.updated",
      source: "projects",
      payload: { projectId: row.id, name: row.name, fields: Object.keys(patch) },
    });
  }
  return row ?? null;
}

/** Removes a project. Its items go with it; its tasks and memories don't. */
export async function deleteProject(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(projects)
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  return deleted.length > 0;
}

export interface AddProjectItemInput {
  projectId: string;
  kind: ProjectItem["kind"];
  externalKey?: string | null;
  title: string;
  priority?: ProjectItem["priority"];
  note?: string | null;
}

/**
 * Tracks a ticket against a project, or updates what is tracked when the same
 * ticket is added again — re-adding a ticket to change its priority is the
 * common case, and a second row for the same key would split its history.
 */
export async function addProjectItem(db: Db, input: AddProjectItemInput): Promise<ProjectItem> {
  const externalKey = input.externalKey?.trim() || null;
  if (externalKey) {
    const [existing] = await db
      .select()
      .from(projectItems)
      .where(
        and(eq(projectItems.projectId, input.projectId), eq(projectItems.externalKey, externalKey)),
      );
    if (existing) {
      const [updated] = await db
        .update(projectItems)
        .set({
          title: input.title,
          priority: input.priority ?? existing.priority,
          note: input.note ?? existing.note,
          updatedAt: new Date(),
        })
        .where(eq(projectItems.id, existing.id))
        .returning();
      return updated!;
    }
  }

  const [row] = await db
    .insert(projectItems)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      externalKey,
      title: input.title,
      priority: input.priority ?? "medium",
      note: input.note ?? null,
    })
    .returning();
  await emitEvent(db, {
    type: "project.item_added",
    source: "projects",
    payload: {
      projectId: input.projectId,
      itemId: row!.id,
      kind: row!.kind,
      externalKey,
      priority: row!.priority,
    },
  });
  return row!;
}

/**
 * A project's items, most urgent first. Postgres orders an enum by its
 * declaration order, which `project_item_priority` declares urgent-first, so the
 * sort needs no CASE expression.
 */
export async function listProjectItems(
  db: Db,
  projectId: string,
  options: { includeDone?: boolean } = {},
): Promise<ProjectItem[]> {
  const conditions = [eq(projectItems.projectId, projectId)];
  if (!options.includeDone) conditions.push(isNull(projectItems.doneAt));
  return db
    .select()
    .from(projectItems)
    .where(and(...conditions))
    .orderBy(asc(projectItems.priority), asc(projectItems.createdAt));
}

export interface UpdateProjectItemInput {
  title?: string;
  priority?: ProjectItem["priority"];
  note?: string | null;
  /** True marks the item done, false reopens it. */
  done?: boolean;
}

export async function updateProjectItem(
  db: Db,
  id: string,
  patch: UpdateProjectItemInput,
): Promise<ProjectItem | null> {
  const [row] = await db
    .update(projectItems)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.done !== undefined ? { doneAt: patch.done ? new Date() : null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projectItems.id, id))
    .returning();
  return row ?? null;
}

export async function removeProjectItem(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(projectItems)
    .where(eq(projectItems.id, id))
    .returning({ id: projectItems.id });
  return deleted.length > 0;
}

export interface ProjectOverview {
  project: Project;
  items: ProjectItem[];
  /** Open tasks the user has attached to this project. */
  openTasks: Task[];
}

/**
 * Everything about one project that a planning turn needs, in one read: the
 * project, its outstanding items by priority, and the user's own open tasks
 * against it.
 */
export async function projectOverview(db: Db, id: string): Promise<ProjectOverview | null> {
  const project = await getProject(db, id);
  if (!project) return null;
  const [items, openTasks] = await Promise.all([
    listProjectItems(db, id),
    db
      .select()
      .from(tasks)
      .where(and(eq(tasks.projectId, id), eq(tasks.status, "open")))
      .orderBy(asc(tasks.targetDate)),
  ]);
  return { project, items, openTasks };
}
