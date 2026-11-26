import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { raiseAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";
import { type AttentionNavTarget, type WorkStream, workStreams } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { parseEvery } from "../headsDown/routines.ts";
import { OPEN_STREAM_STATUSES, type WatchFields } from "./service.ts";

/**
 * Watches: work streams that wait for something to happen ("tell me when Alex
 * merges his PRs") rather than work to push. A heads-down pass is given the
 * ones due a check, looks with its read tools, and reports back with
 * `report_watch`. A watch that is met tells the user and closes; one that
 * reaches its expiry closes and says so. The cadence is the stream's own
 * `wakeAt`, so no scheduler beyond the heads-down loop is involved.
 */

/** Passes can be minutes apart; a watch checked on every one would crowd out the work. */
export const MIN_WATCH_EVERY_MINUTES = 15;
export const MAX_WATCH_EVERY_MINUTES = 7 * 24 * 60;
/** A watch nobody remembers setting shouldn't go off months later. */
export const MAX_WATCH_MINUTES = 30 * 24 * 60;
export const DEFAULT_WATCH_EVERY = "1h";
export const DEFAULT_WATCH_EXPIRES_IN = "7d";
/** Checks one pass takes on, most overdue first; the rest wait for the next pass. */
export const MAX_WATCHES_PER_PASS = 5;

/** What the user wrote, before it is checked: durations like `30m`, `3h` or `2d`. */
export interface WatchRequest {
  condition: string;
  every?: string;
  expiresIn?: string;
}

/** Turns a request into the stored fields, or says what is wrong with it. */
export function watchFields(
  request: WatchRequest,
  now: Date = new Date(),
): WatchFields | { error: string } {
  const condition = request.condition.trim();
  if (!condition) return { error: "a watch needs a condition" };
  const everyMinutes = parseEvery(request.every ?? DEFAULT_WATCH_EVERY);
  if (
    everyMinutes === null ||
    everyMinutes < MIN_WATCH_EVERY_MINUTES ||
    everyMinutes > MAX_WATCH_EVERY_MINUTES
  ) {
    return { error: "every must be a duration from 15m to 7d, such as 30m, 3h or 1d" };
  }
  const lifetimeMinutes = parseEvery(request.expiresIn ?? DEFAULT_WATCH_EXPIRES_IN);
  if (
    lifetimeMinutes === null ||
    lifetimeMinutes < everyMinutes ||
    lifetimeMinutes > MAX_WATCH_MINUTES
  ) {
    return {
      error: "expiresIn must be a duration such as 1d or 7d, no shorter than every and at most 30d",
    };
  }
  return { condition, everyMinutes, expiresAt: minutesAfter(now, lifetimeMinutes) };
}

const openWatch = () =>
  and(eq(workStreams.kind, "watch"), inArray(workStreams.status, [...OPEN_STREAM_STATUSES]));

/**
 * Open, unpaused watches due a check at `now`, those waiting longest first. A
 * watch never checked has no `wakeAt` and goes first.
 */
export async function dueWatches(
  db: Db,
  now: Date,
  limit = MAX_WATCHES_PER_PASS,
): Promise<WorkStream[]> {
  return db
    .select()
    .from(workStreams)
    .where(
      and(
        openWatch(),
        isNull(workStreams.pausedAt),
        gt(workStreams.expiresAt, now),
        or(isNull(workStreams.wakeAt), lte(workStreams.wakeAt, now)),
      ),
    )
    .orderBy(sql`${workStreams.wakeAt} asc nulls first`, asc(workStreams.createdAt))
    .limit(limit);
}

/**
 * Fixed headings for the bell items. The watch's title, written by a chat
 * turn, goes in the body so it can't pose as app text.
 */
export const WATCH_MET_TITLE = "A watch went off";
export const WATCH_EXPIRED_TITLE = "A watch expired";

function watchDedupeKey(watch: WorkStream): string {
  return `watch:${watch.id}`;
}

function minutesAfter(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

/**
 * Closes every open watch past its expiry, paused ones included, and tells the
 * user about each. Claimed in one update, so two passes can't both report one.
 */
export async function expireWatches(db: Db, now: Date): Promise<WorkStream[]> {
  const expired = await db
    .update(workStreams)
    .set({ status: "dropped", closedAt: now, updatedAt: now })
    .where(and(openWatch(), lte(workStreams.expiresAt, now)))
    .returning();
  for (const watch of expired) {
    await emitEvent(db, {
      type: "work_stream.closed",
      source: "work_streams",
      payload: { streamId: watch.id, title: watch.title, status: watch.status, kind: watch.kind },
    });
    await raiseAttention(db, {
      category: watch.category ?? "general",
      kind: "message",
      title: WATCH_EXPIRED_TITLE,
      body: `${watch.title}\nNothing seen before it expired, so it stopped watching for: ${watch.watchCondition}`,
      navTarget: { type: "heads-down" },
      dedupeKey: watchDedupeKey(watch),
    });
  }
  return expired;
}

/**
 * Pushes the next check of the watches a pass was given back by their cadence
 * when the pass starts. A report overwrites it; a watch the pass couldn't
 * check waits its cadence instead of taking a slot on every pass.
 */
export async function markWatchesOffered(db: Db, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(workStreams)
    .set({
      wakeAt: sql`${now.toISOString()}::timestamptz + ${workStreams.watchEveryMinutes} * interval '1 minute'`,
    })
    .where(and(inArray(workStreams.id, [...ids]), openWatch()));
}

export interface WatchCheck {
  met: boolean;
  /** What the check found, in the pass's words. */
  finding: string;
  /** Where clicking the bell item goes when the watch is met; the Heads down page otherwise. */
  navTarget?: AttentionNavTarget;
}

/**
 * Records one check of a watch. Met: tells the user and closes it as done. Not
 * met: keeps what was found and moves the next check on by its cadence. The
 * finding goes in `waitingOn`, which the stream's card already shows, rather
 * than the notes, which would grow by one on every check. Null, with nothing
 * written or raised, when the watch is gone, closed, expired, or paused by
 * the user since it was read.
 */
export async function recordWatchCheck(
  db: Db,
  watch: WorkStream,
  check: WatchCheck,
  now: Date = new Date(),
): Promise<WorkStream | null> {
  const finding = check.finding.trim();
  // Checked in the update itself, so a watch the user drops mid-pass can't come back as "went off".
  const stillLive = and(
    eq(workStreams.id, watch.id),
    openWatch(),
    isNull(workStreams.pausedAt),
    gt(workStreams.expiresAt, now),
  );
  if (!check.met) {
    const [row] = await db
      .update(workStreams)
      .set({
        waitingOn: finding || null,
        wakeAt: minutesAfter(now, watch.watchEveryMinutes ?? MIN_WATCH_EVERY_MINUTES),
        updatedAt: now,
      })
      .where(stillLive)
      .returning();
    return row ?? null;
  }
  const [closed] = await db
    .update(workStreams)
    .set({
      status: "done",
      waitingOn: null,
      notes: [...watch.notes, { at: now.toISOString(), text: `Condition met: ${finding}` }],
      closedAt: now,
      updatedAt: now,
    })
    .where(stillLive)
    .returning();
  if (!closed) return null;
  await emitEvent(db, {
    type: "work_stream.closed",
    source: "work_streams",
    payload: { streamId: closed.id, title: closed.title, status: closed.status, kind: closed.kind },
  });
  await raiseAttention(db, {
    category: watch.category ?? "general",
    kind: "message",
    title: WATCH_MET_TITLE,
    body: `${watch.title}\n${finding}`,
    navTarget: check.navTarget ?? { type: "heads-down" },
    dedupeKey: watchDedupeKey(watch),
  });
  return closed;
}
