import { and, desc, eq, gte, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { events, type EventRow } from "../db/schema.ts";

/**
 * The local event log: meaningful actions get recorded here so a later
 * reconciliation phase can turn them into memories. This is an analytics trail,
 * but private and on-device — UI navigation and Omni layout building are
 * deliberately *not* events.
 */

/**
 * Known event types. The HTTP ingestion endpoint only accepts these, so the
 * frontend (or anything else) can't fill the log with arbitrary types. Backend
 * hooks emit the same set directly.
 *
 * Dotted `domain.action` naming; extend deliberately rather than ad hoc.
 */
export const EVENT_TYPES = [
  "chat.started",
  "task.created",
  "task.completed",
  "pr.viewed",
  "alarm.created",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export interface RecordEventInput {
  type: EventType;
  /** Where it came from, e.g. "chat", "tasks", "github", "alarms". */
  source?: string;
  payload?: Record<string, unknown>;
  /** When the action happened; defaults to now. */
  occurredAt?: Date;
}

/** Inserts an event and returns the row. Throws on failure. */
export async function recordEvent(
  db: Db,
  input: RecordEventInput,
): Promise<EventRow> {
  const [row] = await db
    .insert(events)
    .values({
      type: input.type,
      source: input.source ?? null,
      payload: input.payload ?? null,
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return row!;
}

/**
 * Best-effort emission for in-process hooks: never let a logging failure break
 * the action that triggered it (creating a task, starting a chat). Errors are
 * logged and swallowed.
 */
export async function emitEvent(
  db: Db,
  input: RecordEventInput,
): Promise<void> {
  try {
    await recordEvent(db, input);
  } catch (e) {
    console.error(
      `[events] failed to record ${input.type}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

export interface ListEventsOptions {
  type?: EventType;
  /** Only events at or after this instant. */
  since?: Date;
  /** Only events not yet folded into memory (processedAt IS NULL). */
  unprocessedOnly?: boolean;
  limit?: number;
}

/** Lists events newest-first, with optional filters. */
export async function listEvents(
  db: Db,
  options: ListEventsOptions = {},
): Promise<EventRow[]> {
  const conditions: SQL[] = [];
  if (options.type) conditions.push(eq(events.type, options.type));
  if (options.since) conditions.push(gte(events.occurredAt, options.since));
  if (options.unprocessedOnly) conditions.push(isNull(events.processedAt));

  return db
    .select()
    .from(events)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(events.occurredAt))
    .limit(options.limit ?? 100);
}
