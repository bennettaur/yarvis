import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type AttentionCategory, workStreams } from "../db/schema.ts";
import { findStreamsLinkedTo, OPEN_STREAM_STATUSES } from "../workStreams/service.ts";

/**
 * The category a work stream gives the items raised about it, or null when the
 * stream is closed, missing, or has none set.
 */
export async function streamCategory(
  db: Db,
  streamId: string | null | undefined,
): Promise<AttentionCategory | null> {
  if (!streamId) return null;
  const [row] = await db
    .select({ category: workStreams.category, status: workStreams.status })
    .from(workStreams)
    .where(eq(workStreams.id, streamId));
  if (!row || !isOpen(row.status)) return null;
  return row.category;
}

/**
 * The category for something a workspace's Claude session raised: that of the
 * open work stream the workspace belongs to, else `build`, since a workspace
 * is where the user's own code gets written.
 */
export async function workspaceCategory(
  db: Db,
  workspaceId: string | null | undefined,
): Promise<AttentionCategory> {
  if (!workspaceId) return "build";
  const streams = await findStreamsLinkedTo(db, { kind: "workspace", workspaceId });
  const stream = streams.find((s) => isOpen(s.status) && s.category);
  return stream?.category ?? "build";
}

function isOpen(status: string): boolean {
  return (OPEN_STREAM_STATUSES as readonly string[]).includes(status);
}
