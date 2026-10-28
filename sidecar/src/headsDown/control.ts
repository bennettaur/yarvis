import { z } from "zod";
import type { Db } from "../db/client.ts";
import type { HeadsDownRun } from "../db/schema.ts";
import { claimJob, finishJob } from "../jobs/store.ts";
import { dropOpenStreams } from "../workStreams/service.ts";
import { dismissOpenQuestions } from "./attention.ts";
import { publish } from "./hub.ts";
import {
  deleteAllMessages,
  getActiveRun,
  pauseRun,
  resumeRun,
  type StartRunOptions,
  setStopAt,
  startRun,
  stopRun,
} from "./service.ts";
import {
  abortHeadsDownPass,
  rescheduleHeadsDown,
  updatePassStopTime,
  wakeHeadsDown,
} from "./wake.ts";

/**
 * Starting, stopping, pausing and resuming heads-down mode, and setting when
 * it stops, shared by the page, the chat tools and the loop's scheduled stop
 * so each does the same steps. Clearing out its old work lives here too.
 */

export const NOT_RUNNING = "heads-down mode isn't on";

/** A stop time has to be ahead, or the run would stop the moment it starts. */
export const STOP_TIME_PASSED = "that stop time has already passed";

const CLEAR_WHILE_RUNNING = "pause or stop heads-down mode before clearing";

/** A pass paused on another instance can still be finishing its last tool call. */
const CLEAR_WHILE_PASS_RUNS = "a pass is still finishing; try again in a minute";

/**
 * The database lease a pass holds while it runs, on whichever instance runs
 * it. Clearing holds it too, so no pass starts partway through.
 */
export const PASS_LEASE_NAME = "heads-down";
const CLEAR_LEASE_MS = 60_000;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_WITH_OFFSET = z.string().datetime({ offset: true });

/**
 * Reads a stop time: a local "HH:MM", meaning its next occurrence on this
 * machine's clock (a time already past today means tomorrow, as on the page),
 * or an ISO timestamp with a UTC offset. Null when it is neither.
 */
export function parseStopTime(input: string, now = new Date()): Date | null {
  const hhmm = HHMM.exec(input);
  if (hhmm) {
    const at = new Date(now);
    at.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }
  return ISO_WITH_OFFSET.safeParse(input).success ? new Date(input) : null;
}

/** Tells the loop and the pass in flight that the stop time changed. */
function stopTimeChanged(run: HeadsDownRun): void {
  rescheduleHeadsDown();
  updatePassStopTime(run.stopAt);
}

/**
 * Turns heads-down mode on, or updates the run already going (see `startRun`),
 * and wakes the loop for a pass.
 */
export async function startHeadsDown(
  db: Db,
  focus: string | null,
  options: StartRunOptions = {},
): Promise<HeadsDownRun | { error: string }> {
  if (options.stopAt && options.stopAt.getTime() <= Date.now()) return { error: STOP_TIME_PASSED };
  const run = await startRun(db, focus, options);
  publish({ type: "changed" });
  if (options.stopAt !== undefined) stopTimeChanged(run);
  wakeHeadsDown();
  return run;
}

/** Sets when the active run stops, or clears it with null. */
export async function setHeadsDownStopTime(
  db: Db,
  stopAt: Date | null,
): Promise<HeadsDownRun | { error: string }> {
  if (stopAt && stopAt.getTime() <= Date.now()) return { error: STOP_TIME_PASSED };
  const run = await setStopAt(db, stopAt);
  if (!run) return { error: NOT_RUNNING };
  publish({ type: "changed" });
  stopTimeChanged(run);
  return run;
}

/**
 * Stops the run and the pass in flight, and dismisses its open questions,
 * since no pass would read the answers.
 */
export async function stopHeadsDown(db: Db): Promise<HeadsDownRun | null> {
  const run = await stopRun(db);
  abortHeadsDownPass();
  await dismissOpenQuestions(db);
  publish({ type: "changed" });
  return run;
}

/**
 * Stops the pass in flight and runs no more until resumed. Open questions
 * stay: the user can still answer them, and the next pass reads the answers.
 */
export async function pauseHeadsDown(db: Db): Promise<HeadsDownRun | null> {
  const run = await pauseRun(db);
  if (run) abortHeadsDownPass();
  publish({ type: "changed" });
  return run;
}

/**
 * Starts heads-down mode over: drops every open work stream, deletes the
 * user's messages, and dismisses open questions, which were about that work.
 * Refused while a run is going and not paused, or while a pass holds the
 * lease, since a pass may be partway through those streams.
 */
export async function clearHeadsDown(
  db: Db,
): Promise<{ droppedStreams: number; deletedMessages: number } | { error: string }> {
  if (!(await claimJob(db, PASS_LEASE_NAME, CLEAR_LEASE_MS))) {
    return { error: CLEAR_WHILE_PASS_RUNS };
  }
  try {
    const run = await getActiveRun(db);
    if (run && run.pausedAt === null) return { error: CLEAR_WHILE_RUNNING };
    const droppedStreams = await dropOpenStreams(db);
    const deletedMessages = await deleteAllMessages(db);
    await dismissOpenQuestions(db);
    publish({ type: "changed" });
    return { droppedStreams: droppedStreams.length, deletedMessages };
  } finally {
    await finishJob(db, PASS_LEASE_NAME, { status: "skipped" });
  }
}

/** Resumes a paused run and wakes the loop for a pass. Null when no run was paused. */
export async function resumeHeadsDown(db: Db): Promise<HeadsDownRun | null> {
  const run = await resumeRun(db);
  if (!run) return null;
  publish({ type: "changed" });
  wakeHeadsDown();
  return run;
}
