import { and, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Artifact, artifacts } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import {
  applyDiagramChanges,
  checkDiagram,
  type DiagramChanges,
  DiagramError,
  onlyAdds,
  parseDiagram,
  parseElements,
  serializeDiagram,
} from "./diagram.ts";
import { publishArtifactChange } from "./hub.ts";

/**
 * Documents the assistant writes for itself or for the user and reads back
 * later: a morning brief, a scratchpad, a running log heads-down mode adds to
 * across passes.
 *
 * Like the agent's todos, these are not exposed over the MCP endpoint. A Claude
 * Code session writing to them would be one agent editing another's notes.
 */

/**
 * Caps how big one artifact can get. Reading it back puts the whole thing in
 * the model's context, so past this it should be split or summarized instead.
 */
export const MAX_ARTIFACT_CHARS = 100_000;

/**
 * How long a heads-down pass or specialist can make an artifact a chat turn
 * created. Half the cap, so the user always has room to keep adding to it.
 */
export const CHAT_ARTIFACT_RUN_LIMIT = MAX_ARTIFACT_CHARS / 2;

/** How many artifacts a listing returns, newest change first. */
export const ARTIFACT_LIST_LIMIT = 100;

export class ArtifactTooLargeError extends Error {
  constructor() {
    super(`artifact would exceed ${MAX_ARTIFACT_CHARS} characters`);
  }
}

/** A heads-down pass or specialist tried to rewrite, rename or delete an artifact a chat turn created. */
export class ArtifactAppendOnlyError extends Error {
  constructor() {
    super("only a chat turn can rewrite, rename or delete an artifact a chat turn created");
  }
}

/** A heads-down pass or specialist tried to grow a chat turn's artifact past CHAT_ARTIFACT_RUN_LIMIT. */
export class ArtifactRunLimitError extends Error {
  constructor() {
    super(`a run can't grow a chat turn's artifact past ${CHAT_ARTIFACT_RUN_LIMIT} characters`);
  }
}

/** `update_artifact`'s content and append are text edits, which would corrupt a diagram's JSON. */
export class NotADocumentError extends Error {
  constructor(format: Artifact["format"]) {
    super(`the content of a ${format}-format artifact can't be edited as text`);
  }
}

/** The artifact exists but isn't a diagram, so update_diagram can't change it. */
export class NotADiagramError extends Error {
  constructor() {
    super("that artifact is not a diagram");
  }
}

/** Who is making a write: a chat turn, a heads-down pass, or a specialist run. */
export type ArtifactWriter = Artifact["createdBy"];

export interface CreateArtifactInput {
  title: string;
  content?: string;
  format?: Artifact["format"];
  writer?: ArtifactWriter;
  /** The writer has read something untrusted, so this text may come from it. */
  untrusted?: boolean;
}

export interface UpdateArtifactInput {
  title?: string;
  /** Replaces the whole content. */
  content?: string;
  /** Added to the end of the content, after `content` if both are given. */
  append?: string;
  writer?: ArtifactWriter;
  /** The writer has read something untrusted, so this text may come from it. */
  untrusted?: boolean;
}

/** What a listing shows: everything but the content, which can be large. */
export type ArtifactSummary = Omit<Artifact, "content"> & { length: number };

/**
 * What an artifact's events record. An untrusted title stays out: search_events
 * returns payloads as they are, and consolidation can turn them into memories.
 */
function eventPayload(row: Artifact) {
  return {
    artifactId: row.id,
    createdBy: row.createdBy,
    ...(row.untrusted ? {} : { title: row.title }),
  };
}

export async function createArtifact(db: Db, input: CreateArtifactInput): Promise<Artifact> {
  const content = input.content ?? "";
  if (content.length > MAX_ARTIFACT_CHARS) throw new ArtifactTooLargeError();
  const writer = input.writer ?? "chat";
  const [row] = await db
    .insert(artifacts)
    .values({
      title: input.title.trim(),
      content,
      format: input.format ?? "markdown",
      createdBy: writer,
      untrusted: writer !== "chat" || Boolean(input.untrusted),
    })
    .returning();
  await emitEvent(db, {
    type: "artifact.created",
    source: "artifacts",
    payload: eventPayload(row!),
  });
  publishArtifactChange(row!.id, "updated");
  return row!;
}

export async function getArtifact(db: Db, id: string): Promise<Artifact | null> {
  const [row] = await db.select().from(artifacts).where(eq(artifacts.id, id));
  return row ?? null;
}

/** Most recently changed first, so the one being worked on is at the top. */
export async function listArtifacts(
  db: Db,
  options: { titleContains?: string } = {},
): Promise<ArtifactSummary[]> {
  const query = options.titleContains?.trim();
  return db
    .select({
      id: artifacts.id,
      title: artifacts.title,
      format: artifacts.format,
      createdBy: artifacts.createdBy,
      untrusted: artifacts.untrusted,
      createdAt: artifacts.createdAt,
      updatedAt: artifacts.updatedAt,
      length: sql<number>`char_length(${artifacts.content})`.mapWith(Number),
    })
    .from(artifacts)
    .where(query ? ilike(artifacts.title, `%${escapeLike(query)}%`) : undefined)
    .orderBy(desc(artifacts.updatedAt))
    .limit(ARTIFACT_LIST_LIMIT);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Appending happens in SQL rather than as read-then-write, so two passes adding
 * to the same scratchpad at once both land.
 *
 * A heads-down pass or specialist can only append to an artifact a chat turn
 * created: a rewrite would wipe the user's document with no history to restore.
 */
export async function updateArtifact(
  db: Db,
  id: string,
  patch: UpdateArtifactInput,
): Promise<Artifact | null> {
  // Nothing to change: don't bump it to the top of the list or log an edit.
  if (patch.title === undefined && patch.content === undefined && !patch.append) {
    return getArtifact(db, id);
  }
  const writer = patch.writer ?? "chat";
  const editsText = patch.content !== undefined || Boolean(patch.append);
  const rewrites = patch.title !== undefined || patch.content !== undefined;
  const appendOnly = writer !== "chat" && rewrites;
  const base = patch.content !== undefined ? sql`${patch.content}` : sql`${artifacts.content}`;
  const next = patch.append ? sql`${base} || ${patch.append}` : base;

  const [row] = await db
    .update(artifacts)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      content: next,
      ...(writer !== "chat" || patch.untrusted ? { untrusted: true } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(artifacts.id, id),
        editsText ? eq(artifacts.format, "markdown") : undefined,
        sql`char_length(${next}) <= ${MAX_ARTIFACT_CHARS}`,
        // An append-only writer skips a chat turn's artifact. When no row comes
        // back, the branch below tells "no such artifact" from "refused".
        appendOnly ? ne(artifacts.createdBy, "chat") : undefined,
        writer === "chat"
          ? undefined
          : sql`(${artifacts.createdBy} <> 'chat' OR char_length(${next}) <= ${CHAT_ARTIFACT_RUN_LIMIT})`,
      ),
    )
    .returning();

  if (!row) {
    // No row: no such artifact, or one of the checks in the WHERE failed.
    const current = await getArtifact(db, id);
    if (!current) return null;
    if (editsText && current.format !== "markdown") throw new NotADocumentError(current.format);
    if (writer !== "chat" && current.createdBy === "chat") {
      throw appendOnly ? new ArtifactAppendOnlyError() : new ArtifactRunLimitError();
    }
    throw new ArtifactTooLargeError();
  }
  await emitEvent(db, {
    type: "artifact.updated",
    source: "artifacts",
    payload: eventPayload(row),
  });
  publishArtifactChange(row.id, "updated");
  return row;
}

/**
 * A chat turn can delete any artifact. A heads-down pass or specialist can only
 * delete its own: deleting the user's document is as lossy as rewriting it.
 * Throws ArtifactAppendOnlyError when it tries.
 */
export async function deleteArtifact(
  db: Db,
  id: string,
  writer: ArtifactWriter = "chat",
): Promise<boolean> {
  if (writer === "chat") return (await deleteArtifacts(db, [id])) > 0;
  const deleted = await db
    .delete(artifacts)
    .where(and(eq(artifacts.id, id), ne(artifacts.createdBy, "chat")))
    .returning({ id: artifacts.id });
  if (deleted.length > 0) {
    publishArtifactChange(id, "deleted");
    return true;
  }
  // Nothing deleted: it's gone, or it came from a chat.
  if (await getArtifact(db, id)) throw new ArtifactAppendOnlyError();
  return false;
}

/** Deletes every artifact named; returns how many were deleted. */
export async function deleteArtifacts(db: Db, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await db
    .delete(artifacts)
    .where(inArray(artifacts.id, ids))
    .returning({ id: artifacts.id });
  for (const row of deleted) publishArtifactChange(row.id, "deleted");
  return deleted.length;
}

export interface CreateDiagramInput {
  title: string;
  /** Excalidraw element skeletons, checked against `diagramElementSchema`. */
  elements: unknown[];
  writer?: ArtifactWriter;
  untrusted?: boolean;
}

/** Throws DiagramError naming the first element that is malformed or doesn't fit with the rest. */
export async function createDiagram(db: Db, input: CreateDiagramInput): Promise<Artifact> {
  return createArtifact(db, {
    title: input.title,
    content: serializeDiagram(checkDiagram({ elements: parseElements(input.elements) })),
    format: "excalidraw",
    writer: input.writer,
    untrusted: input.untrusted,
  });
}

/** Worded for the model, which reads it back as the tool's error. */
const ADD_ONLY_BROKEN =
  "addOnly is set, but this change renames the diagram, removes something, or changes an element that already exists. Leave addOnly out to make that change.";

export interface UpdateDiagramInput {
  title?: string;
  changes: DiagramChanges;
  /** The caller promised the change only adds; refused if it touches anything already there. */
  addOnly?: boolean;
  writer?: ArtifactWriter;
  untrusted?: boolean;
}

/**
 * Applies changes to a diagram under a row lock, since each change is a
 * read-modify-write of the whole JSON and two at once would drop one.
 *
 * A heads-down pass or specialist can only add elements to a diagram a chat
 * turn created, the diagram version of append-only, and only up to
 * CHAT_ARTIFACT_RUN_LIMIT characters. What it adds can still be drawn over
 * what the chat drew; the write marks the diagram untrusted.
 *
 * `addOnly` is checked here, under the lock, because the approval that
 * `addOnly` skips is decided before the call can see which ids exist.
 */
export async function updateDiagram(
  db: Db,
  id: string,
  input: UpdateDiagramInput,
): Promise<Artifact | null> {
  const writer = input.writer ?? "chat";
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(artifacts).where(eq(artifacts.id, id)).for("update");
    if (!current) return null;
    if (current.format !== "excalidraw") throw new NotADiagramError();
    const diagram = parseDiagram(current.content);
    const adds = input.title === undefined && onlyAdds(diagram, input.changes);
    if (input.addOnly && !adds) throw new DiagramError(ADD_ONLY_BROKEN);
    const editsChatDiagram = writer !== "chat" && current.createdBy === "chat";
    if (editsChatDiagram && !adds) throw new ArtifactAppendOnlyError();
    const content = serializeDiagram(applyDiagramChanges(diagram, input.changes));
    if (content.length > MAX_ARTIFACT_CHARS) throw new ArtifactTooLargeError();
    if (editsChatDiagram && content.length > CHAT_ARTIFACT_RUN_LIMIT)
      throw new ArtifactRunLimitError();
    const [updated] = await tx
      .update(artifacts)
      .set({
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        content,
        ...(writer !== "chat" || input.untrusted ? { untrusted: true } : {}),
        updatedAt: new Date(),
      })
      .where(eq(artifacts.id, id))
      .returning();
    return updated ?? null;
  });
  if (!row) return null;
  await emitEvent(db, {
    type: "artifact.updated",
    source: "artifacts",
    payload: eventPayload(row),
  });
  publishArtifactChange(row.id, "updated");
  return row;
}
