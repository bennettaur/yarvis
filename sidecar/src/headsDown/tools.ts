import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  NOT_RUNNING,
  parseStopTime,
  pauseHeadsDown,
  resumeHeadsDown,
  setHeadsDownStopTime,
  startHeadsDown,
  stopHeadsDown,
} from "./control.ts";
import { getActiveRun } from "./service.ts";

// Local time is the user's: the sidecar runs on their machine, and the model
// has no clock or time zone to build an offset timestamp from.
const stopAtSchema = z
  .string()
  .refine((s) => parseStopTime(s) !== null, "give a local time as HH:MM, or an ISO timestamp")
  .describe(
    'When it stops on its own: the user\'s local time as 24-hour "HH:MM" (e.g. "19:00" for 7pm; a time already past today means tomorrow), or an ISO timestamp with a UTC offset for another day',
  );

/**
 * The chat's handle on heads-down mode: start it once the user agrees, pause,
 * resume or stop it, set when it stops, and see whether it is running. The
 * loop itself runs elsewhere.
 */
export function buildHeadsDownTools(db: Db) {
  return {
    start_heads_down: tool({
      description:
        "Turn on heads-down mode: an unattended loop that keeps pushing the user's work streams forward (starting work on tickets, chasing CI and reviews, asking the user only what it must) until they stop it, or until the stop time they give. Offer it once you and the user have planned the work and it is tracked as work streams, and call it only when they say yes. Pass their focus in their own words. Calling it while it runs updates the focus and the stop time.",
      inputSchema: z.object({
        focus: z
          .string()
          .max(2000)
          .optional()
          .describe("What the user wants it to push on, in their words"),
        stopAt: stopAtSchema.optional(),
      }),
      execute: async ({ focus, stopAt }) => {
        const run = await startHeadsDown(db, focus?.trim() || null, {
          stopAt: stopAt ? parseStopTime(stopAt) : undefined,
        });
        if ("error" in run) return run;
        return {
          runId: run.id,
          status: run.status,
          paused: run.pausedAt !== null,
          stopAt: run.stopAt?.toISOString() ?? null,
          message: "Heads-down mode is on. The user can follow it on the Heads down page.",
        };
      },
    }),

    stop_heads_down: tool({
      description: "Turn heads-down mode off, when the user asks.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await stopHeadsDown(db);
        return run ? { stopped: true } : { stopped: false, message: "heads-down mode wasn't on" };
      },
    }),

    pause_heads_down: tool({
      description:
        "Pause heads-down mode, when the user asks: no passes run until they resume it, but its work streams, open questions and messages are kept. To leave only one piece of work alone, pause that work stream instead.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await pauseHeadsDown(db);
        return run ? { paused: true } : { paused: false, message: NOT_RUNNING };
      },
    }),

    resume_heads_down: tool({
      description: "Resume heads-down mode after the user paused it, when they ask.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await resumeHeadsDown(db);
        return run
          ? { resumed: true }
          : { resumed: false, message: "heads-down mode isn't on, or isn't paused" };
      },
    }),

    set_heads_down_stop_time: tool({
      description:
        "Set when heads-down mode stops on its own, or clear it with null so it runs until the user stops it. Only when the user asks.",
      inputSchema: z.object({ stopAt: stopAtSchema.nullable() }),
      execute: async ({ stopAt }) => {
        const run = await setHeadsDownStopTime(db, stopAt ? parseStopTime(stopAt) : null);
        if ("error" in run) return run;
        return { stopAt: run.stopAt?.toISOString() ?? null };
      },
    }),

    heads_down_status: tool({
      description: "Whether heads-down mode is running or paused, its focus, and when it stops.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await getActiveRun(db);
        return run
          ? {
              running: true,
              paused: run.pausedAt !== null,
              focus: run.focus,
              startedAt: run.startedAt.toISOString(),
              stopAt: run.stopAt?.toISOString() ?? null,
            }
          : { running: false };
      },
    }),
  };
}
