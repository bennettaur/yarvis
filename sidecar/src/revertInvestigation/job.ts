import { everyHours } from "../jobs/schedule.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { detectReverts, settleFinished } from "./service.ts";

const HOUR_MS = 60 * 60 * 1000;

/** How far back a first run looks. */
const BACKFILL_MS = 3 * 24 * HOUR_MS;

/** Each run re-reads this much before the last one ended; known reverts are skipped. */
const OVERLAP_MS = 6 * HOUR_MS;

function sinceFrom(cursor: unknown, now: Date): Date {
  const value = (cursor as { nextSince?: unknown } | null)?.nextSince;
  const at = typeof value === "string" ? new Date(value) : null;
  return at && !Number.isNaN(at.getTime()) ? at : new Date(now.getTime() - BACKFILL_MS);
}

export const revertInvestigationJob: JobDefinition = {
  name: "revert-investigation",
  description:
    "Every hour, look for reverts of PRs you shipped in your registered repos and ask whether to investigate them. Tells you when an investigation's write-up is ready.",
  schedule: everyHours(1),
  run: async ({ db, config, cursor, now }) => {
    const since = sinceFrom(cursor, now);
    const found = await detectReverts(db, config, since);
    const ready = await settleFinished(db);
    const notes = found.errors.length ? ` (${found.errors.join("; ")})` : "";
    return {
      // A run that failed on a repo keeps its window so the next run retries it.
      cursor: found.errors.length
        ? cursor
        : { nextSince: new Date(now.getTime() - OVERLAP_MS).toISOString() },
      skipped: found.detected === 0 && ready === 0 && found.errors.length === 0,
      detail: `found ${found.detected} revert(s), ${ready} write-up(s) ready${notes}`,
    };
  },
};
