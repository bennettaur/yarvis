import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type AttentionItemRow, type AttentionNavTarget, attentionItems } from "../db/schema.ts";

/**
 * The attention stream service. Producers (a Claude Code hook via the ingest
 * route, or the in-app chat agent) create items; the frontend lists pending
 * items, opens an SSE stream for live deltas, and patches an item's status as
 * the user reads / resolves / dismisses it.
 */

export type AttentionSource = "claude-hook" | "chat-agent" | "system";
export type AttentionKind = "permission" | "idle" | "completed" | "error" | "info";
export type AttentionStatus = "pending" | "read" | "resolved" | "dismissed";

export interface CreateAttentionInput {
  source: AttentionSource;
  /** "ws-claude:<workspaceId>" for a Claude session; null for sourceless nudges. */
  sessionKey?: string | null;
  workspaceId?: string | null;
  kind: AttentionKind;
  title: string;
  body?: string | null;
  navTarget?: AttentionNavTarget | null;
  payload?: unknown;
}

/**
 * Creates an attention item, coalescing so a session that re-prompts doesn't
 * stack duplicates: at most one pending item per (sessionKey, kind). A
 * `completed` signal for a session also resolves that session's other still
 * pending items — a finished session supersedes whatever it was waiting on.
 *
 * Returns the resulting row (freshly inserted or the updated pending one).
 */
export async function createAttention(
  db: Db,
  input: CreateAttentionInput,
): Promise<AttentionItemRow> {
  const sessionKey = input.sessionKey ?? null;

  return db.transaction(async (tx) => {
    if (input.kind === "completed" && sessionKey) {
      // The session finished; its outstanding "blocked" prompts no longer need action.
      await tx
        .update(attentionItems)
        .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(attentionItems.sessionKey, sessionKey),
            eq(attentionItems.status, "pending"),
            ne(attentionItems.kind, "completed"),
          ),
        );
    }

    const [row] = await tx
      .insert(attentionItems)
      .values({
        source: input.source,
        sessionKey,
        workspaceId: input.workspaceId ?? null,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        navTarget: input.navTarget ?? null,
        payload: (input.payload ?? null) as AttentionItemRow["payload"],
      })
      // Coalesce onto the live pending row for this (sessionKey, kind). The
      // partial unique index only covers pending rows, and NULL sessionKeys are
      // distinct, so sourceless nudges never collapse into each other.
      .onConflictDoUpdate({
        target: [attentionItems.sessionKey, attentionItems.kind],
        targetWhere: sql`${attentionItems.status} = 'pending'`,
        set: {
          title: input.title,
          body: input.body ?? null,
          navTarget: input.navTarget ?? null,
          payload: (input.payload ?? null) as AttentionItemRow["payload"],
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  });
}

export interface ListAttentionOptions {
  status?: AttentionStatus;
  limit?: number;
}

/** Upper bound on a single list response. */
const MAX_LIMIT = 500;

/** Lists attention items filtered by status, newest-first (by the `seq` cursor). */
export async function listAttention(
  db: Db,
  options: ListAttentionOptions = {},
): Promise<AttentionItemRow[]> {
  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, MAX_LIMIT) : MAX_LIMIT;

  return db
    .select()
    .from(attentionItems)
    .where(options.status ? eq(attentionItems.status, options.status) : undefined)
    .orderBy(desc(attentionItems.seq))
    .limit(limit);
}

/** Terminal + read statuses stamp the matching timestamp column. */
export async function updateAttentionStatus(
  db: Db,
  id: string,
  status: AttentionStatus,
): Promise<AttentionItemRow | undefined> {
  const now = new Date();
  const [row] = await db
    .update(attentionItems)
    .set({
      status,
      updatedAt: now,
      ...(status === "read" ? { readAt: now } : {}),
      ...(status === "resolved" || status === "dismissed" ? { resolvedAt: now } : {}),
    })
    .where(eq(attentionItems.id, id))
    .returning();
  return row;
}
