import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type EventRow, events } from "../db/schema.ts";

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
 * Dotted `domain.action` naming; extend deliberately rather than ad hoc. The
 * consolidation job groups by the leading domain, so a new type belongs under an
 * existing prefix wherever one fits.
 */
export const EVENT_TYPES = [
  "chat.started",
  "task.created",
  "task.completed",
  "task.rolled_over",
  "pr.viewed",
  "pr.guide.generated",
  "pr.guide.viewed",
  "pr.insight.created",
  "pr.insight.viewed",
  "pr.commented",
  "pr.approved",
  "pr.changes_requested",
  "pr.review_commented",
  "pr.marked_ready",
  "pr.merged",
  "issue.created",
  "issue.commented",
  "issue.work_started",
  "jira.issue.created",
  "jira.issue.updated",
  "jira.issue.commented",
  "jira.work_started",
  "workspace.created",
  "workspace.session_started",
  "workspace.instruction_sent",
  "workspace.synced",
  "workspace.comment_added",
  "workspace.archived",
  "calendar.event_created",
  "todo.created",
  "todo.updated",
  "todo.closed",
  "project.created",
  "project.updated",
  "project.item_added",
  "memory.consolidated",
  "cc.session_summarized",
  "suggestion.dismissed",
  "alarm.created",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The event types that count as reviewing someone else's code. The planner uses
 * this to notice a week with little review in it, so the definition lives here
 * next to the type list rather than being re-derived at each call site.
 */
export const REVIEW_EVENT_TYPES: readonly EventType[] = [
  "pr.viewed",
  "pr.commented",
  "pr.approved",
  "pr.changes_requested",
  "pr.review_commented",
  "pr.guide.generated",
  "pr.insight.created",
];

export interface RecordEventInput {
  type: EventType;
  /** Where it came from, e.g. "chat", "tasks", "github", "alarms". */
  source?: string;
  payload?: Record<string, unknown>;
  /** When the action happened; defaults to now. */
  occurredAt?: Date;
}

/** Inserts an event and returns the row. Throws on failure. */
export async function recordEvent(db: Db, input: RecordEventInput): Promise<EventRow> {
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
export async function emitEvent(db: Db, input: RecordEventInput): Promise<void> {
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
  /** Any of these types; combines with `type` as one set. */
  types?: readonly EventType[];
  /** Only events at or after this instant. */
  since?: Date;
  /** Only events at or before this instant. */
  until?: Date;
  /** Substring match against the type, source, and serialized payload. */
  search?: string;
  /** Only events not yet folded into memory (processedAt IS NULL). */
  unprocessedOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Oldest-first, which is the order a consolidation run wants to read in. */
  oldestFirst?: boolean;
}

/**
 * Builds the WHERE clause shared by listing and counting, so a paginated read's
 * total can never be computed over a different filter than its rows.
 */
function eventConditions(options: ListEventsOptions): SQL | undefined {
  const conditions: SQL[] = [];
  const types = [...(options.types ?? []), ...(options.type ? [options.type] : [])];
  if (types.length === 1) conditions.push(eq(events.type, types[0]!));
  else if (types.length > 1) conditions.push(inArray(events.type, [...types]));
  if (options.since) conditions.push(gte(events.occurredAt, options.since));
  if (options.until) conditions.push(lte(events.occurredAt, options.until));
  if (options.unprocessedOnly) conditions.push(isNull(events.processedAt));
  const search = options.search?.trim();
  if (search) {
    // The payload shape differs per type, so a free-text browse matches its
    // serialized form rather than guessing which key the user meant. `%` and `_`
    // are escaped so a pasted PR title can't turn into a wildcard scan.
    const pattern = `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    const clause = or(
      sql`${events.type} ILIKE ${pattern}`,
      sql`coalesce(${events.source}, '') ILIKE ${pattern}`,
      sql`coalesce(${events.payload}::text, '') ILIKE ${pattern}`,
    );
    if (clause) conditions.push(clause);
  }
  return conditions.length ? and(...conditions) : undefined;
}

/** Lists events newest-first (unless asked otherwise), with optional filters. */
export async function listEvents(db: Db, options: ListEventsOptions = {}): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(eventConditions(options))
    .orderBy(options.oldestFirst ? asc(events.occurredAt) : desc(events.occurredAt))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0);
}

/** How many events match a filter, for a paginated browse. */
export async function countEvents(db: Db, options: ListEventsOptions = {}): Promise<number> {
  const [row] = await db.select({ total: count() }).from(events).where(eventConditions(options));
  return Number(row?.total ?? 0);
}

export interface EventPage {
  items: EventRow[];
  total: number;
}

/**
 * One page of the log plus the size of the full match, so the events browser can
 * show "page 2 of 40" without reading everything.
 */
export async function pageEvents(db: Db, options: ListEventsOptions = {}): Promise<EventPage> {
  const [items, total] = await Promise.all([listEvents(db, options), countEvents(db, options)]);
  return { items, total };
}

/**
 * Marks events as folded into memory. Called after a consolidation run stores
 * its summary, so a later run doesn't summarize the same window again.
 */
export async function markEventsProcessed(db: Db, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const updated = await db
    .update(events)
    .set({ processedAt: new Date() })
    .where(inArray(events.id, ids))
    .returning({ id: events.id });
  return updated.length;
}

export interface EventTypeCount {
  type: EventType;
  count: number;
}

/**
 * Counts by type over a window. This is what answers "have I reviewed anything
 * this week" without pulling every row back to the caller.
 */
export async function countEventsByType(
  db: Db,
  options: Pick<ListEventsOptions, "since" | "until" | "types"> = {},
): Promise<EventTypeCount[]> {
  const rows = await db
    .select({ type: events.type, total: count() })
    .from(events)
    .where(eventConditions(options))
    .groupBy(events.type)
    // Name breaks a tie, so a caller (and a test) reading equal counts gets a
    // stable order rather than whatever the plan happened to produce.
    .orderBy(desc(count()), asc(events.type));
  return rows.map((r) => ({ type: r.type as EventType, count: Number(r.total) }));
}
