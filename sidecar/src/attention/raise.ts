import type { Db } from "../db/client.ts";
import type {
  AttentionCategory,
  AttentionItemRow,
  AttentionNavTarget,
  RiskLevel,
} from "../db/schema.ts";
import { publish } from "./hub.ts";
import { type AttentionSource, clearAttentionScope, createAttention } from "./service.ts";

/** What background work and the assistant may raise: something to do, or a note to read. */
export const RAISABLE_KINDS = ["action", "message"] as const;

/**
 * How background work (heads-down passes, routines, specialists) and the
 * assistant leave the user an action or a note in the attention stream.
 * `action` is something the user has to do; `message` is a note, which reading
 * clears.
 */
export interface RaiseAttentionInput {
  category: AttentionCategory;
  kind: (typeof RAISABLE_KINDS)[number];
  /**
   * Shown as the row's heading and the notification's title. Written by the
   * app, never a model; third-party text (PR titles, messages) goes in `body`.
   */
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
  /** A prepared PR's verification risk level, which the stream colours the item by. */
  risk?: RiskLevel | null;
  /** Defaults to `system`; the assistant's tool passes `chat-agent`. */
  source?: AttentionSource;
}

/**
 * Stored as the item's session key, which is what pending items coalesce on.
 * Keyed by source too, so an agent re-raising a key can't rewrite an item the
 * app itself raised.
 */
export function raisedSessionKey(source: AttentionSource, dedupeKey: string): string {
  return `${raisedSessionKeyPrefix(source)}${dedupeKey}`;
}

/** What every session key raised by `source` starts with, for matching them in SQL. */
export function raisedSessionKeyPrefix(source: AttentionSource = "system"): string {
  return `raise:${source}:`;
}

/** The dedupe key an item raised by `source` was raised under, or null for any other item. */
export function raisedDedupeKey(
  sessionKey: string,
  source: AttentionSource = "system",
): string | null {
  const prefix = raisedSessionKeyPrefix(source);
  return sessionKey.startsWith(prefix) ? sessionKey.slice(prefix.length) : null;
}

/** Raises (or refreshes) an item and publishes it to connected clients. */
export async function raiseAttention(
  db: Db,
  input: RaiseAttentionInput,
): Promise<AttentionItemRow> {
  const source = input.source ?? "system";
  const item = await createAttention(db, {
    source,
    sessionKey: input.dedupeKey ? raisedSessionKey(source, input.dedupeKey) : null,
    kind: input.kind,
    category: input.category,
    title: input.title,
    body: input.body ?? null,
    navTarget: input.navTarget ?? null,
    risk: input.risk ?? null,
  });
  publish(item);
  return item;
}

/**
 * Resolves the pending items raised under a dedupe key, for when the thing
 * they asked about no longer needs the user (the PR merged, the review landed).
 */
export async function resolveRaisedAttention(
  db: Db,
  dedupeKey: string,
  source: AttentionSource = "system",
): Promise<void> {
  const rows = await clearAttentionScope(
    db,
    { sessionKey: raisedSessionKey(source, dedupeKey) },
    "resolved",
  );
  for (const row of rows) publish(row);
}
