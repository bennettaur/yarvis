import type { Db } from "../db/client.ts";
import type { EventRow } from "../db/schema.ts";
import { type EventType, listEvents, recordEventOnce } from "../events/service.ts";
import { GitHubClient, type ReviewContribution, reviewExternalId } from "../github/client.ts";
import { refKey } from "../pr/types.ts";
import type { JobDefinition } from "./scheduler.ts";

/**
 * Copies the review verdicts the user gave on github.com into the event log.
 *
 * Reviews submitted in Yarvis are logged as they happen. This job logs the ones
 * given in the browser, so the weekly summary, the review-cadence nudge and the
 * activity summaries count them too. A review is identified by its GitHub node
 * id (`externalId`), which the in-app submit path records as well, so the same
 * approval is never logged twice.
 *
 * Only approvals and change requests are synced. GitHub also records a single
 * inline comment as a COMMENTED review, and the app logs those as `pr.commented`
 * with no review id, so syncing COMMENTED reviews would log each one twice.
 */

/** The event a synced verdict becomes, matching what the in-app submit logs. */
const EVENT_BY_STATE: Partial<Record<ReviewContribution["state"], EventType>> = {
  approved: "pr.approved",
  changes_requested: "pr.changes_requested",
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a run reads when there is no readable cursor. */
const BACKFILL_MS = 14 * DAY_MS;

/**
 * The oldest a window may start. GitHub rejects a contributions window longer
 * than a year, so a cursor left stale by a long absence would otherwise fail
 * every run.
 */
const MAX_WINDOW_MS = 364 * DAY_MS;

/**
 * Each run re-reads this much before where the last one ended, since GitHub can
 * take a while to list a contribution. Already-logged reviews are skipped by id.
 */
const OVERLAP_MS = DAY_MS;

/**
 * An in-app event with no `externalId` this close to a review's submit time is
 * taken to be that review. In-app events lack the id when an earlier version of
 * Yarvis logged them, or when GitHub's submit reply had no node id. The event is
 * written right after GitHub accepts the review, so minutes is generous.
 */
const ID_LESS_MATCH_MS = 5 * 60 * 1000;

export interface SyncWindow {
  from: Date;
  to: Date;
}

interface SyncCursor {
  /** Where the next run's window starts, as an ISO timestamp. */
  nextFrom: string;
}

function parseCursor(cursor: unknown): Date | null {
  const value = (cursor as Partial<SyncCursor> | null)?.nextFrom;
  if (typeof value !== "string") return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The window a run reads, from its cursor or, without one, the backfill. */
export function syncWindow(cursor: unknown, now: Date): SyncWindow {
  const start = parseCursor(cursor)?.getTime() ?? now.getTime() - BACKFILL_MS;
  return { from: new Date(Math.max(start, now.getTime() - MAX_WINDOW_MS)), to: now };
}

/**
 * Where the next window starts. A read the page cap cut short carries on from
 * the last review it got, so the reviews after it aren't skipped.
 */
export function nextCursor(
  window: SyncWindow,
  read: { contributions: ReviewContribution[]; truncated: boolean },
): SyncCursor {
  const last = read.contributions.at(-1);
  if (read.truncated && last) return { nextFrom: last.submittedAt };
  return { nextFrom: new Date(window.to.getTime() - OVERLAP_MS).toISOString() };
}

function payloadRef(event: EventRow): string | null {
  const ref = (event.payload as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : null;
}

/**
 * Finds an event with no id that is this review: the same verdict on the same
 * PR, logged within a few minutes of GitHub's timestamp.
 */
function findIdLessMatch(
  candidates: EventRow[],
  type: EventType,
  ref: string,
  submittedAt: Date,
): EventRow | undefined {
  return candidates.find(
    (event) =>
      event.type === type &&
      payloadRef(event) === ref &&
      Math.abs(event.occurredAt.getTime() - submittedAt.getTime()) <= ID_LESS_MATCH_MS,
  );
}

/** Logs the given reviews that the log doesn't already hold. Returns how many were added. */
export async function recordReviewContributions(
  db: Db,
  contributions: ReviewContribution[],
  window: SyncWindow,
): Promise<number> {
  const idLess = await listEvents(db, {
    types: Object.values(EVENT_BY_STATE),
    withoutExternalId: true,
    // Widened by the match tolerance so an event logged just before the
    // window's start can still claim a review just inside it.
    since: new Date(window.from.getTime() - ID_LESS_MATCH_MS),
    until: new Date(window.to.getTime() + ID_LESS_MATCH_MS),
    // Far more in-app reviews than one window holds; synced and newly
    // submitted reviews carry an id and aren't counted here.
    limit: 1000,
  });

  let added = 0;
  for (const contribution of contributions) {
    const type = EVENT_BY_STATE[contribution.state];
    if (!type) continue;
    const submittedAt = new Date(contribution.submittedAt);
    const ref = refKey({
      provider: "github",
      owner: contribution.owner,
      repo: contribution.repo,
      number: contribution.number,
    });
    const match = findIdLessMatch(idLess, type, ref, submittedAt);
    if (match) {
      // One event stands for one review, so it can't also claim a second
      // approval of the same PR a minute later.
      idLess.splice(idLess.indexOf(match), 1);
      continue;
    }
    const row = await recordEventOnce(db, {
      type,
      source: "github-sync",
      // Only the ref: the payload is fed to the consolidation model, and a PR
      // title is text anyone opening a PR controls.
      payload: { ref },
      occurredAt: submittedAt,
      externalId: reviewExternalId(contribution.reviewId),
    });
    if (row) added++;
  }
  return added;
}

export const githubReviewSyncJob: JobDefinition = {
  name: "github-review-sync",
  description:
    "Every 30 minutes, log the approvals and change requests you gave on github.com, so they count alongside the ones given in Yarvis.",
  schedule: { kind: "interval", everyMs: 30 * 60 * 1000 },
  run: async ({ db, config, cursor, now }) => {
    const token = config.secrets?.githubToken;
    if (!token) return { skipped: true, detail: "no GitHub token configured" };
    const window = syncWindow(cursor, now);
    const read = await new GitHubClient(token).reviewContributions(window.from, window.to);
    const added = await recordReviewContributions(db, read.contributions, window);
    const notes = [
      read.truncated ? "hit the page cap, the next run carries on" : null,
      read.restrictedCount > 0
        ? `${read.restrictedCount} contribution(s) hidden from this token; check its repo access and SSO authorization`
        : null,
    ].filter(Boolean);
    return {
      cursor: nextCursor(window, read),
      skipped: added === 0 && notes.length === 0,
      detail:
        `logged ${added} of ${read.contributions.length} GitHub review(s) since ${window.from.toISOString()}` +
        (notes.length ? ` (${notes.join("; ")})` : ""),
    };
  },
};
