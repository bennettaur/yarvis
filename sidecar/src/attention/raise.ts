import type { Db } from "../db/client.ts";
import type { AttentionCategory, AttentionItemRow, AttentionNavTarget } from "../db/schema.ts";
import { publish } from "./hub.ts";
import { type AttentionSource, clearAttentionScope, createAttention } from "./service.ts";

/**
 * The one way a pass, routine, specialist or the assistant puts something in
 * the attention stream. `action` is something the user has to do; `message` is
 * a note Yarvis leaves them, which reading clears.
 */
export interface RaiseAttentionInput {
  category: AttentionCategory;
  kind: "action" | "message";
  /** Shown as the row's heading. Keep third-party text (PR titles, messages) in `body`. */
  title: string;
  body?: string | null;
  /** Where clicking the item takes the user. */
  navTarget?: AttentionNavTarget | null;
  /**
   * Names the thing the item is about, e.g. `review:gh:owner/repo/7`. Raising
   * again with the same key and kind while the first is pending updates it
   * instead of adding a second.
   */
  dedupeKey?: string | null;
  /** Defaults to `system`; the assistant's tool passes `chat-agent`. */
  source?: AttentionSource;
}

const DEDUPE_PREFIX = "raise:";

/** Stored as the item's session key, which is what pending items coalesce on. */
function sessionKeyFor(dedupeKey: string): string {
  return `${DEDUPE_PREFIX}${dedupeKey}`;
}

/** Raises (or refreshes) an item and pushes it to open streams. */
export async function raiseAttention(
  db: Db,
  input: RaiseAttentionInput,
): Promise<AttentionItemRow> {
  const item = await createAttention(db, {
    source: input.source ?? "system",
    sessionKey: input.dedupeKey ? sessionKeyFor(input.dedupeKey) : null,
    kind: input.kind,
    category: input.category,
    title: input.title,
    body: input.body ?? null,
    navTarget: input.navTarget ?? null,
  });
  publish(item);
  return item;
}

/**
 * Resolves the pending items raised under a dedupe key, for when the thing
 * they asked about no longer needs the user (the PR merged, the review landed).
 */
export async function resolveRaisedAttention(db: Db, dedupeKey: string): Promise<void> {
  const rows = await clearAttentionScope(db, { sessionKey: sessionKeyFor(dedupeKey) }, "resolved");
  for (const row of rows) publish(row);
}
