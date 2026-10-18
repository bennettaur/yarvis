import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { publish } from "./hub.ts";
import { getActiveRun, startRun, stopRun } from "./service.ts";
import { abortHeadsDownPass, wakeHeadsDown } from "./wake.ts";

/**
 * The chat's handle on heads-down mode: start it once the user agrees, stop
 * it, and see whether it is running. The loop itself runs elsewhere.
 */
export function buildHeadsDownTools(db: Db) {
  return {
    start_heads_down: tool({
      description:
        "Turn on heads-down mode: an unattended loop that keeps pushing the user's work streams forward (starting work on tickets, chasing CI and reviews, asking the user only what it must) until they stop it. Offer it once you and the user have planned the work and it is tracked as work streams, and call it only when they say yes. Pass their focus in their own words. Calling it while it runs updates the focus.",
      inputSchema: z.object({
        focus: z
          .string()
          .max(2000)
          .optional()
          .describe("What the user wants it to push on, in their words"),
      }),
      execute: async ({ focus }) => {
        const run = await startRun(db, focus?.trim() || null);
        publish({ type: "changed" });
        wakeHeadsDown();
        return {
          runId: run.id,
          status: run.status,
          message: "Heads-down mode is on. The user can follow it on the Heads down page.",
        };
      },
    }),

    stop_heads_down: tool({
      description: "Turn heads-down mode off, when the user asks.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await stopRun(db);
        abortHeadsDownPass();
        publish({ type: "changed" });
        return run ? { stopped: true } : { stopped: false, message: "heads-down mode wasn't on" };
      },
    }),

    heads_down_status: tool({
      description: "Whether heads-down mode is running, and its focus.",
      inputSchema: z.object({}),
      execute: async () => {
        const run = await getActiveRun(db);
        return run
          ? { running: true, focus: run.focus, startedAt: run.startedAt.toISOString() }
          : { running: false };
      },
    }),
  };
}
