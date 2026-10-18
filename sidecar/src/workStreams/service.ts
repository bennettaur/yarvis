import { and, asc, desc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type AgentTodoNote,
  type WorkStream,
  type WorkStreamLink,
  type WorkStreamLinkRef,
  workStreamLinks,
  workStreams,
} from "../db/schema.ts";

/**
 * Work streams: the threads of work heads-down mode pushes forward, each with
 * the tickets, workspaces, PRs and messages it involves.
 *
 * Like `agent_todos`, this is the assistant's working state, so it isn't
 * exposed over the MCP endpoint. Unlike a todo, a stream is about work that
 * lives elsewhere, and its links say where.
 */

/** Statuses that mean a stream is still live, for the default listing. */
export const OPEN_STREAM_STATUSES = ["active", "waiting-on-user", "waiting-on-others"] as const;

/** Statuses that close a stream, so `closedAt` is set once and not re-stamped. */
const CLOSED_STATUSES: readonly WorkStream["status"][] = ["done", "dropped"];

export interface WorkStreamWithLinks extends WorkStream {
  links: WorkStreamLink[];
}

export interface CreateStreamInput {
  title: string;
  summary?: string | null;
  status?: WorkStream["status"];
  priority?: WorkStream["priority"];
  projectId?: string | null;
  nextAction?: string | null;
  waitingOn?: string | null;
  wakeAt?: Date | null;
  note?: string;
}

export interface UpdateStreamInput {
  title?: string;
  summary?: string | null;
  status?: WorkStream["status"];
  priority?: WorkStream["priority"];
  projectId?: string | null;
  nextAction?: string | null;
  waitingOn?: string | null;
  wakeAt?: Date | null;
  /** Appended to the notes rather than replacing them. */
  note?: string;
}

export interface ListStreamsOptions {
  statuses?: readonly WorkStream["status"][];
  projectId?: string;
  /** Only streams that are awake at this instant: no `wakeAt`, or one already passed. */
  awakeAt?: Date;
}

export interface LinkInput {
  ref: WorkStreamLinkRef;
  title?: string | null;
  state?: string | null;
}

/**
 * A link's identity within a stream. Two refs with the same key are the same
 * thing seen twice, so the second write updates the first link.
 */
export function refKeyOf(ref: WorkStreamLinkRef): string {
  switch (ref.kind) {
    case "ticket":
      return `ticket:${ref.provider}:${ref.key}`;
    case "workspace":
      return `workspace:${ref.workspaceId}`;
    case "pr":
      return `pr:${ref.url}`;
    case "message":
    case "review-request":
      return `${ref.kind}:${ref.channel}:${ref.conversation}:${ref.messageRef}`;
  }
}

function appendNote(existing: AgentTodoNote[], note: string, at: Date): AgentTodoNote[] {
  return [...existing, { at: at.toISOString(), text: note }];
}

export async function createStream(db: Db, input: CreateStreamInput): Promise<WorkStream> {
  const now = new Date();
  const status = input.status ?? "active";
  const [row] = await db
    .insert(workStreams)
    .values({
      title: input.title.trim(),
      summary: input.summary ?? null,
      status,
      priority: input.priority ?? "medium",
      projectId: input.projectId ?? null,
      nextAction: input.nextAction ?? null,
      waitingOn: input.waitingOn ?? null,
      wakeAt: input.wakeAt ?? null,
      notes: input.note ? appendNote([], input.note, now) : [],
      closedAt: CLOSED_STATUSES.includes(status) ? now : null,
    })
    .returning();
  return row!;
}

async function linksFor(db: Db, streamIds: string[]): Promise<Map<string, WorkStreamLink[]>> {
  const byStream = new Map<string, WorkStreamLink[]>();
  if (streamIds.length === 0) return byStream;
  const rows = await db
    .select()
    .from(workStreamLinks)
    .where(inArray(workStreamLinks.streamId, streamIds))
    .orderBy(asc(workStreamLinks.createdAt));
  for (const row of rows) {
    const list = byStream.get(row.streamId) ?? [];
    list.push(row);
    byStream.set(row.streamId, list);
  }
  return byStream;
}

export async function getStream(db: Db, id: string): Promise<WorkStreamWithLinks | null> {
  const [row] = await db.select().from(workStreams).where(eq(workStreams.id, id));
  if (!row) return null;
  return { ...row, links: (await linksFor(db, [row.id])).get(row.id) ?? [] };
}

/** Live streams first by priority, then the ones touched longest ago, which are most likely to need a look. */
export async function listStreams(
  db: Db,
  options: ListStreamsOptions = {},
): Promise<WorkStreamWithLinks[]> {
  const conditions: SQL[] = [];
  const statuses = options.statuses ?? OPEN_STREAM_STATUSES;
  if (statuses.length) conditions.push(inArray(workStreams.status, [...statuses]));
  if (options.projectId) conditions.push(eq(workStreams.projectId, options.projectId));
  if (options.awakeAt) {
    const awake = or(isNull(workStreams.wakeAt), lte(workStreams.wakeAt, options.awakeAt));
    if (awake) conditions.push(awake);
  }
  const rows = await db
    .select()
    .from(workStreams)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(workStreams.priority), asc(workStreams.updatedAt));
  const links = await linksFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, links: links.get(r.id) ?? [] }));
}

export async function updateStream(
  db: Db,
  id: string,
  patch: UpdateStreamInput,
): Promise<WorkStream | null> {
  const [existing] = await db.select().from(workStreams).where(eq(workStreams.id, id));
  if (!existing) return null;
  const now = new Date();
  const closing = patch.status !== undefined && CLOSED_STATUSES.includes(patch.status);
  const reopening =
    patch.status !== undefined && !closing && CLOSED_STATUSES.includes(existing.status);

  const [row] = await db
    .update(workStreams)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
      ...(patch.nextAction !== undefined ? { nextAction: patch.nextAction } : {}),
      ...(patch.waitingOn !== undefined ? { waitingOn: patch.waitingOn } : {}),
      ...(patch.wakeAt !== undefined ? { wakeAt: patch.wakeAt } : {}),
      ...(patch.note ? { notes: appendNote(existing.notes, patch.note, now) } : {}),
      ...(closing && !existing.closedAt ? { closedAt: now } : {}),
      ...(reopening ? { closedAt: null } : {}),
      updatedAt: now,
    })
    .where(eq(workStreams.id, id))
    .returning();
  return row ?? null;
}

/**
 * Links something to a stream, or updates the link when the stream already
 * has it. A title or state left out keeps the one already recorded.
 */
export async function linkToStream(
  db: Db,
  streamId: string,
  input: LinkInput,
): Promise<WorkStreamLink> {
  const now = new Date();
  const observed = input.state !== undefined && input.state !== null;
  const [row] = await db
    .insert(workStreamLinks)
    .values({
      streamId,
      kind: input.ref.kind,
      refKey: refKeyOf(input.ref),
      ref: input.ref,
      title: input.title ?? null,
      state: input.state ?? null,
      observedAt: observed ? now : null,
    })
    .onConflictDoUpdate({
      target: [workStreamLinks.streamId, workStreamLinks.refKey],
      set: {
        ref: input.ref,
        title: sql`coalesce(excluded.title, ${workStreamLinks.title})`,
        state: sql`coalesce(excluded.state, ${workStreamLinks.state})`,
        observedAt: observed ? now : sql`${workStreamLinks.observedAt}`,
        updatedAt: now,
      },
    })
    .returning();
  // Linking something to a stream is activity on it, for the oldest-first ordering.
  await db.update(workStreams).set({ updatedAt: now }).where(eq(workStreams.id, streamId));
  return row!;
}

export async function unlink(db: Db, linkId: string): Promise<boolean> {
  const deleted = await db
    .delete(workStreamLinks)
    .where(eq(workStreamLinks.id, linkId))
    .returning({ id: workStreamLinks.id });
  return deleted.length > 0;
}

/** The streams something is linked to, newest activity first: "which stream is this PR part of?" */
export async function streamsLinkedTo(db: Db, ref: WorkStreamLinkRef): Promise<WorkStream[]> {
  return db
    .select({ stream: workStreams })
    .from(workStreamLinks)
    .innerJoin(workStreams, eq(workStreams.id, workStreamLinks.streamId))
    .where(eq(workStreamLinks.refKey, refKeyOf(ref)))
    .orderBy(desc(workStreams.updatedAt))
    .then((rows) => rows.map((r) => r.stream));
}
