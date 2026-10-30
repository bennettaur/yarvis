import { and, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Artifact, artifacts } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

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

/** How many artifacts a listing returns, newest change first. */
export const ARTIFACT_LIST_LIMIT = 100;

export class ArtifactTooLargeError extends Error {
  constructor() {
    super(`artifact would exceed ${MAX_ARTIFACT_CHARS} characters`);
  }
}

export type ArtifactWriter = Artifact["createdBy"];

export interface CreateArtifactInput {
  title: string;
  content?: string;
  format?: Artifact["format"];
  writer?: ArtifactWriter;
}

export interface UpdateArtifactInput {
  title?: string;
  /** Replaces the whole content. */
  content?: string;
  /** Added to the end of the content, after `content` if both are given. */
  append?: string;
  writer?: ArtifactWriter;
}

/**
 * True once a heads-down pass or a specialist run has written to it, so the text
 * may carry instructions from something it read rather than from the user.
 */
export function isWrittenUnattended(artifact: Pick<Artifact, "createdBy" | "writtenUnattended">) {
  return artifact.createdBy !== "chat" || artifact.writtenUnattended;
}

/** What a listing shows: everything but the content, which can be large. */
export type ArtifactSummary = Omit<Artifact, "content"> & { length: number };

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
      writtenUnattended: writer !== "chat",
    })
    .returning();
  await emitEvent(db, {
    type: "artifact.created",
    source: "artifacts",
    payload: { artifactId: row!.id, title: row!.title },
  });
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
      writtenUnattended: artifacts.writtenUnattended,
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
  const base = patch.content !== undefined ? sql`${patch.content}` : sql`${artifacts.content}`;
  const next = patch.append ? sql`${base} || ${patch.append}` : base;

  const [row] = await db
    .update(artifacts)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      content: next,
      ...(patch.writer && patch.writer !== "chat" ? { writtenUnattended: true } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(artifacts.id, id), sql`char_length(${next}) <= ${MAX_ARTIFACT_CHARS}`))
    .returning();

  if (!row) {
    // No row means either no such artifact or the size check failed; only the
    // second is worth a distinct error.
    if (await getArtifact(db, id)) throw new ArtifactTooLargeError();
    return null;
  }
  await emitEvent(db, {
    type: "artifact.updated",
    source: "artifacts",
    payload: { artifactId: row.id, title: row.title },
  });
  return row;
}

export async function deleteArtifact(db: Db, id: string): Promise<boolean> {
  const deleted = await db
    .delete(artifacts)
    .where(eq(artifacts.id, id))
    .returning({ id: artifacts.id });
  return deleted.length > 0;
}
