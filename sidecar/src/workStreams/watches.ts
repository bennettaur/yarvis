import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { raiseAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";
import { type AttentionNavTarget, type WorkStream, workStreams } from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { parseEvery } from "../headsDown/routines.ts";
import { OPEN_STREAM_STATUSES, updateStream, type WatchFields } from "./service.ts";

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
  const lifetime = parseEvery(request.expiresIn ?? DEFAULT_WATCH_EXPIRES_IN);
  if (lifetime === null || lifetime < everyMinutes || lifetime > MAX_WATCH_MINUTES) {
    return {
      error: "expiresIn must be a duration such as 1d or 7d, no shorter than every and at most 30d",
    };
  }
  return { condition, everyMinutes, expiresAt: new Date(now.getTime() + lifetime * 60_000) };
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

/** The bell item's heading. App text: the watch's own title, model-written, goes in the body. */
export const WATCH_MET_TITLE = "A watch went off";
export const WATCH_EXPIRED_TITLE = "A watch expired";

function dedupeKey(watch: WorkStream): string {
  return `watch:${watch.id}`;
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
      body: `${watch.title}\nNothing seen by ${watch.expiresAt?.toLocaleString() ?? "its expiry"}, so it stopped watching for: ${watch.watchCondition}`,
      navTarget: { type: "heads-down" },
      dedupeKey: dedupeKey(watch),
    });
  }
  return expired;
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
 * met: keeps what was found and moves the next check on by its cadence. Null
 * when the watch is gone or the user paused it since it was read.
 */
export async function recordWatchCheck(
  db: Db,
  watch: WorkStream,
  check: WatchCheck,
  now: Date = new Date(),
): Promise<WorkStream | null> {
  const finding = check.finding.trim();
  if (!check.met) {
    return updateStream(
      db,
      watch.id,
      {
        waitingOn: finding || null,
        wakeAt: new Date(now.getTime() + (watch.watchEveryMinutes ?? 60) * 60_000),
      },
      { unlessPaused: true },
    );
  }
  const closed = await updateStream(
    db,
    watch.id,
    { status: "done", waitingOn: null, note: `Condition met: ${finding}` },
    { unlessPaused: true },
  );
  if (!closed) return null;
  await raiseAttention(db, {
    category: watch.category ?? "general",
    kind: "message",
    title: WATCH_MET_TITLE,
    body: `${watch.title}\n${finding}`,
    navTarget: check.navTarget ?? { type: "heads-down" },
    dedupeKey: dedupeKey(watch),
  });
  return closed;
}
