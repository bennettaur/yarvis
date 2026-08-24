import { runSpecialist } from "../agents/run.ts";
import type { EventRow } from "../db/schema.ts";
import { emitEvent, listEvents, markEventsProcessed } from "../events/service.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { dailyAt, everyHours } from "./schedule.ts";
import type { JobDefinition } from "./scheduler.ts";

/**
 * Turning the raw event trail into memory.
 *
 * Two passes. Every few hours, whatever hasn't been folded in yet becomes one
 * `activity-summary` — cheap, and it keeps "what am I in the middle of" fresh
 * without a model having to read hundreds of rows at question time. Then
 * overnight, the day's window summaries become a single `day-summary`, which is
 * what a weekly recap reads.
 *
 * Events are only marked processed once a summary has actually been stored, so a
 * run that fails (or finds no model configured) leaves the window to be picked up
 * by the next one rather than losing it.
 */

/** Ceiling on events folded into one window, so a busy day can't blow the prompt. */
const MAX_EVENTS_PER_RUN = 400;

/** A window with fewer events than this isn't worth a model call. */
const MIN_EVENTS_TO_SUMMARIZE = 3;

/**
 * The jobs' own bookkeeping. Consolidation emits `memory.consolidated`, and the
 * transcript sweep emits `cc.session_summarized` — folding those into the next
 * window would have the summarizer describing the act of summarizing. They are
 * still marked processed, so they don't accumulate as a permanently unprocessed
 * tail that keeps tripping the minimum above.
 */
const BOOKKEEPING_TYPES: readonly string[] = ["memory.consolidated", "cc.session_summarized"];

/** Renders one event as a line of material. */
function eventLine(event: EventRow): string {
  const at = event.occurredAt.toISOString().slice(0, 16).replace("T", " ");
  const detail = event.payload ? JSON.stringify(event.payload) : "";
  return `${at} ${event.type}${event.source ? ` (${event.source})` : ""} ${detail}`.trim();
}

/** Chronological material for a window of events. */
export function eventMaterial(events: EventRow[]): string {
  return events.map(eventLine).join("\n");
}

export const consolidateEventsJob: JobDefinition = {
  name: "consolidate-events",
  description:
    "Every four hours, summarize the activity events that haven't been folded into memory yet.",
  schedule: everyHours(4),
  run: async ({ db, config, now }) => {
    const claimed = await listEvents(db, {
      unprocessedOnly: true,
      until: now,
      limit: MAX_EVENTS_PER_RUN,
      oldestFirst: true,
    });
    const events = claimed.filter((event) => !BOOKKEEPING_TYPES.includes(event.type));
    if (events.length < MIN_EVENTS_TO_SUMMARIZE) {
      return { skipped: true, detail: `only ${events.length} unprocessed event(s); leaving them` };
    }

    const from = events[0]!.occurredAt;
    const to = events[events.length - 1]!.occurredAt;
    const run = await runSpecialist({
      config,
      db,
      name: "activity-consolidator",
      task: `Summarize what the user did between ${from.toISOString()} and ${to.toISOString()}, from the ${events.length} activity events below.`,
      material: eventMaterial(events),
    });
    if (!run.text.trim()) {
      return { skipped: true, detail: "the summarizer returned nothing; window left unprocessed" };
    }

    const memory = new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
    const record = await memory.add(run.text.trim(), {
      kind: "activity-summary",
      sourceRef: {
        type: "events",
        from: from.toISOString(),
        to: to.toISOString(),
        eventIds: events.map((e) => e.id),
      },
    });
    await markEventsProcessed(
      db,
      claimed.map((e) => e.id),
    );
    await emitEvent(db, {
      type: "memory.consolidated",
      source: "jobs",
      payload: { memoryId: record.id, kind: "activity-summary", events: events.length },
    });
    return { detail: `summarized ${events.length} event(s) into memory ${record.id}` };
  },
};

/** Local midnight-to-midnight window for the day before `now`. */
export function previousDay(now: Date): { from: Date; to: Date; label: string } {
  const to = new Date(now);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from, to, label: from.toISOString().slice(0, 10) };
}

export const dailyRollupJob: JobDefinition = {
  name: "daily-rollup",
  description:
    "Overnight, fold yesterday's window summaries and session digests into one day summary.",
  schedule: dailyAt(3),
  run: async ({ db, config, now }) => {
    const { from, to, label } = previousDay(now);
    const memory = new PgVectorMemoryStore(db, await chooseEmbedder(config, db));

    // Both halves of the day's record: the four-hourly windows, and whatever the
    // Claude Code sweep digested. A day with neither had no work in it.
    const pieces = (
      await memory.list({
        kinds: ["activity-summary", "session-summary"],
        since: from,
        limit: 50,
      })
    ).filter((m) => m.createdAt < to);
    if (pieces.length === 0) {
      return { skipped: true, detail: `nothing recorded for ${label}` };
    }

    const material = pieces
      .map((m) => `[${m.kind} ${m.createdAt.toISOString()}]\n${m.content}`)
      .join("\n\n");
    const run = await runSpecialist({
      config,
      db,
      name: "activity-consolidator",
      task: `Write one short summary of the user's day on ${label}, combining the ${pieces.length} partial summaries below. Say what they worked on, what they finished, and what is still open.`,
      material,
    });
    if (!run.text.trim()) return { skipped: true, detail: "the summarizer returned nothing" };

    const record = await memory.add(run.text.trim(), {
      kind: "day-summary",
      sourceRef: {
        type: "events",
        from: from.toISOString(),
        to: to.toISOString(),
        // The day summary is built from memories, not events directly; the
        // window is what identifies it.
        eventIds: [],
      },
    });
    await emitEvent(db, {
      type: "memory.consolidated",
      source: "jobs",
      payload: { memoryId: record.id, kind: "day-summary", day: label, pieces: pieces.length },
    });
    return { detail: `summarized ${label} from ${pieces.length} piece(s)` };
  },
};

/** Both consolidation jobs, in the order a tick should consider them. */
export const consolidationJobs: JobDefinition[] = [consolidateEventsJob, dailyRollupJob];
