import { and, asc, desc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type WorkStream,
  type WorkStreamLink,
  type WorkStreamLinkRef,
  type WorkStreamNote,
  workStreamLinks,
  workStreams,
} from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

/**
 * Work streams: the threads of work heads-down mode pushes forward, each with
 * the tickets, workspaces, PRs and messages it involves.
 *
 * Like `agent_todos`, this is the assistant's working state, so it isn't
 * exposed over the MCP endpoint. Unlike a todo, a stream is about work that
 * lives elsewhere, and its links say where.
 *
 * Only opening and closing a stream go to the activity log. A heads-down pass
 * updates its streams every few minutes, and logging each update would bury
 * what the user actually did.
 */

/** Statuses that mean a stream is still live, for the default listing. */
export const OPEN_STREAM_STATUSES = ["active", "waiting-on-user", "waiting-on-others"] as const;

/** Statuses that close a stream, so `closedAt` is set once and not re-stamped. */
const CLOSED_STREAM_STATUSES: readonly WorkStream["status"][] = ["done", "dropped"];

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
  /** Pauses or resumes the stream. Only the user does this. */
  paused?: boolean;
  /** Appended to the notes rather than replacing them. */
  note?: string;
}

export interface ListStreamsOptions {
  statuses?: readonly WorkStream["status"][];
  projectId?: string;
  /** Only streams that are awake at this instant: no `wakeAt`, or one already passed. */
  awakeAt?: Date;
  /** Leave out the streams the user paused. */
  excludePaused?: boolean;
}

export interface LinkToStreamInput {
  ref: WorkStreamLinkRef;
  title?: string | null;
  state?: string | null;
  /** Who is making the link. Defaults to a chat turn. */
  createdBy?: WorkStreamLink["createdBy"];
}

/**
 * A link's identity within a stream. Two refs with the same key are the same
 * thing seen twice, so the second write updates the first link.
 */
export function refKeyOf(ref: WorkStreamLinkRef): string {
  // JSON, not a joined string: a channel or permalink can contain any separator.
  switch (ref.kind) {
    case "ticket":
      // JIRA keys are case-insensitive; GitHub and Azure ones have no letters to differ by.
      return JSON.stringify([ref.kind, ref.provider, ref.key.trim().toUpperCase()]);
    case "workspace":
      return JSON.stringify([ref.kind, ref.workspaceId]);
    case "pr":
      return JSON.stringify([ref.kind, canonicalPrUrl(ref.url)]);
    case "message":
    case "review-request":
      return JSON.stringify([ref.kind, ref.channel, ref.conversation, ref.messageRef]);
  }
}

/**
 * A PR's URL without what varies between links to the same PR: a trailing
 * slash, a sub-page (`/files`), a query or an anchor. GitHub PRs end at
 * `/pull/N` and Azure ones at `/pullrequest/N`.
 */
export function canonicalPrUrl(url: string): string {
  const match = /^(https?:\/\/[^?#]*?\/(?:pull|pullrequest)\/\d+)/i.exec(url.trim());
  return (match?.[1] ?? url.trim()).toLowerCase();
}

function appendNote(existing: WorkStreamNote[], note: string, at: Date): WorkStreamNote[] {
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
      closedAt: CLOSED_STREAM_STATUSES.includes(status) ? now : null,
    })
    .returning();
  await emitEvent(db, {
    type: "work_stream.created",
    source: "work_streams",
    payload: { streamId: row!.id, title: row!.title, priority: row!.priority },
  });
  return row!;
}

async function loadLinksByStream(
  db: Db,
  streamIds: string[],
): Promise<Map<string, WorkStreamLink[]>> {
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
  const links = await loadLinksByStream(db, [row.id]);
  return { ...row, links: links.get(row.id) ?? [] };
}

/**
 * Open streams by default, most urgent first, then the ones touched longest
 * ago, which are most likely to need a look.
 */
export async function listStreams(
  db: Db,
  options: ListStreamsOptions = {},
): Promise<WorkStreamWithLinks[]> {
  const conditions: SQL[] = [];
  const statuses = options.statuses ?? OPEN_STREAM_STATUSES;
  if (statuses.length) conditions.push(inArray(workStreams.status, [...statuses]));
  if (options.projectId) conditions.push(eq(workStreams.projectId, options.projectId));
  if (options.excludePaused) conditions.push(isNull(workStreams.pausedAt));
  if (options.awakeAt) {
    const awake = or(isNull(workStreams.wakeAt), lte(workStreams.wakeAt, options.awakeAt));
    if (awake) conditions.push(awake);
  }
  const rows = await db
    .select()
    .from(workStreams)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(workStreams.priority), asc(workStreams.updatedAt));
  const links = await loadLinksByStream(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, links: links.get(r.id) ?? [] }));
}

/**
 * Applies a patch to a stream. Null when there is no such stream, or with
 * `unlessPaused` when the user has paused it, even between the read and the write.
 */
export async function updateStream(
  db: Db,
  id: string,
  patch: UpdateStreamInput,
  { unlessPaused = false }: { unlessPaused?: boolean } = {},
): Promise<WorkStream | null> {
  const [existing] = await db.select().from(workStreams).where(eq(workStreams.id, id));
  if (!existing) return null;
  const now = new Date();
  const closing = patch.status !== undefined && CLOSED_STREAM_STATUSES.includes(patch.status);
  const reopening =
    patch.status !== undefined && !closing && CLOSED_STREAM_STATUSES.includes(existing.status);

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
      // Pausing a stream that is already paused keeps when it was first paused.
      ...(patch.paused !== undefined
        ? { pausedAt: patch.paused ? (existing.pausedAt ?? now) : null }
        : {}),
      ...(patch.note ? { notes: appendNote(existing.notes, patch.note, now) } : {}),
      ...(closing && !existing.closedAt ? { closedAt: now } : {}),
      ...(reopening ? { closedAt: null } : {}),
      updatedAt: now,
    })
    .where(
      unlessPaused
        ? and(eq(workStreams.id, id), isNull(workStreams.pausedAt))
        : eq(workStreams.id, id),
    )
    .returning();
  if (row && closing && !existing.closedAt) {
    await emitEvent(db, {
      type: "work_stream.closed",
      source: "work_streams",
      payload: { streamId: row.id, title: row.title, status: row.status },
    });
  }
  return row ?? null;
}

/**
 * Drops every open stream, so heads-down mode starts the next run with none.
 * Dropped rather than deleted, so each still reaches the activity log as closed.
 */
export async function dropOpenStreams(db: Db): Promise<WorkStream[]> {
  const now = new Date();
  const rows = await db
    .update(workStreams)
    .set({ status: "dropped", closedAt: now, updatedAt: now })
    .where(inArray(workStreams.status, [...OPEN_STREAM_STATUSES]))
    .returning();
  for (const row of rows) {
    await emitEvent(db, {
      type: "work_stream.closed",
      source: "work_streams",
      payload: { streamId: row.id, title: row.title, status: row.status },
    });
  }
  return rows;
}

/**
 * Links something to a stream, or updates the link when the stream already
 * has it. A title or state left out keeps the one already recorded.
 */
export async function linkToStream(
  db: Db,
  streamId: string,
  input: LinkToStreamInput,
): Promise<WorkStreamLink> {
  const now = new Date();
  const hasObservedState = input.state !== undefined && input.state !== null;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workStreamLinks)
      .values({
        streamId,
        kind: input.ref.kind,
        refKey: refKeyOf(input.ref),
        ref: input.ref,
        title: input.title ?? null,
        state: input.state ?? null,
        observedAt: hasObservedState ? now : null,
        createdBy: input.createdBy ?? "chat",
      })
      .onConflictDoUpdate({
        target: [workStreamLinks.streamId, workStreamLinks.refKey],
        set: {
          // A pass can't rewrite what the user linked, only add to its state.
          ref: sql`case when excluded.created_by = 'chat' or ${workStreamLinks.createdBy} = 'heads-down' then excluded.ref else ${workStreamLinks.ref} end`,
          title: sql`coalesce(excluded.title, ${workStreamLinks.title})`,
          state: sql`coalesce(excluded.state, ${workStreamLinks.state})`,
          // A link the user's chat made stays theirs when a pass touches it
          // again, and becomes theirs when they link what a pass had linked.
          createdBy: sql`case when excluded.created_by = 'chat' then 'chat'::work_stream_link_source else ${workStreamLinks.createdBy} end`,
          ...(hasObservedState ? { observedAt: now } : {}),
          updatedAt: now,
        },
      })
      .returning();
    // Linking something to a stream is activity on it, for the oldest-first ordering.
    await tx.update(workStreams).set({ updatedAt: now }).where(eq(workStreams.id, streamId));
    return row!;
  });
}

/** Whether a stream exists, without loading its links. */
export async function streamExists(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: workStreams.id })
    .from(workStreams)
    .where(eq(workStreams.id, id));
  return row !== undefined;
}

/** The stream a link belongs to, or null when there is no such link. */
export async function streamOfLink(db: Db, linkId: string): Promise<WorkStream | null> {
  const [row] = await db
    .select({ stream: workStreams })
    .from(workStreamLinks)
    .innerJoin(workStreams, eq(workStreams.id, workStreamLinks.streamId))
    .where(eq(workStreamLinks.id, linkId));
  return row?.stream ?? null;
}

export async function unlinkFromStream(db: Db, linkId: string): Promise<boolean> {
  const deleted = await db
    .delete(workStreamLinks)
    .where(eq(workStreamLinks.id, linkId))
    .returning({ id: workStreamLinks.id });
  return deleted.length > 0;
}

/** The streams something is linked to, newest activity first: "which stream is this PR part of?" */
export async function findStreamsLinkedTo(db: Db, ref: WorkStreamLinkRef): Promise<WorkStream[]> {
  const rows = await db
    .select({ stream: workStreams })
    .from(workStreamLinks)
    .innerJoin(workStreams, eq(workStreams.id, workStreamLinks.streamId))
    .where(eq(workStreamLinks.refKey, refKeyOf(ref)))
    .orderBy(desc(workStreams.updatedAt));
  return rows.map((r) => r.stream);
}
