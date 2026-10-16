import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  cancelCheckBack,
  listPendingCheckBacks,
  MAX_CHECK_BACK_ATTEMPTS,
  MAX_DELAY_MINUTES,
  MAX_PROMPT_CHARS,
  MIN_DELAY_MINUTES,
  scheduleCheckBack,
} from "./service.ts";

/** What a turn knows that a check-back it schedules has to carry forward. */
export interface CheckBackTurnContext {
  /** The provider/model this turn runs on, so the follow-up runs on the same one. */
  provider: string | null;
  model: string | null;
  /** The attempt this turn is running, or 0 when the user started it. */
  attempt: number;
}

export function buildCheckBackTools(db: Db, sessionId: string, turn: CheckBackTurnContext) {
  return {
    schedule_check_back: tool({
      description: `Leave yourself a prompt to run later in this same chat, so you can wait on something that takes time — CI finishing, a workspace session getting to a point, a PR being reviewed. Check the thing now first; if it isn't done, schedule a check-back that says exactly what to look at and what to tell the user. When the check-back runs and it still isn't done, schedule another one. A chain stops after ${MAX_CHECK_BACK_ATTEMPTS} checks. Pick a delay that fits how fast the thing changes rather than the shortest one.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe(
            "Self-contained instructions for your future turn: what to check, with which tool and ids, and what to report when it is done",
          ),
        inMinutes: z
          .number()
          .int()
          .min(MIN_DELAY_MINUTES)
          .max(MAX_DELAY_MINUTES)
          .describe("How long from now to run it"),
      }),
      execute: async ({ prompt, inMinutes }) => {
        if (!sessionId) return { error: "there is no chat to come back to from here" };
        const result = await scheduleCheckBack(db, {
          sessionId,
          prompt,
          delayMinutes: inMinutes,
          provider: turn.provider,
          model: turn.model,
          attempt: turn.attempt + 1,
        });
        if ("error" in result) return result;
        return {
          id: result.checkBack.id,
          dueAt: result.checkBack.dueAt.toISOString(),
          attempt: result.checkBack.attempt,
        };
      },
    }),

    list_check_backs: tool({
      description: "List the check-backs still waiting to run in this chat, soonest first.",
      inputSchema: z.object({}),
      execute: async () => {
        if (!sessionId) return { checkBacks: [] };
        const rows = await listPendingCheckBacks(db, sessionId);
        return {
          checkBacks: rows.map((row) => ({
            id: row.id,
            prompt: row.prompt,
            dueAt: row.dueAt.toISOString(),
            attempt: row.attempt,
          })),
        };
      },
    }),

    cancel_check_back: tool({
      description:
        "Cancel a pending check-back in this chat, for example when the user says to stop watching something. Get the id from list_check_backs.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        if (!sessionId) return { cancelled: false };
        return { cancelled: await cancelCheckBack(db, sessionId, id) };
      },
    }),
  };
}
