import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { updateStream } from "../workStreams/service.ts";
import { askQuestion } from "./service.ts";

/**
 * The tools only a heads-down pass has: asking the user without waiting for
 * them, and ending the pass with notes and a sleep length.
 */

/** What `finish_pass` asked for, read by the loop once the pass is over. */
export interface PassOutcome {
  finished: boolean;
  notes: string | null;
  sleepMinutes: number | null;
  reason: string | null;
}

export function newPassOutcome(): PassOutcome {
  return { finished: false, notes: null, sleepMinutes: null, reason: null };
}

export function buildPassTools(db: Db, outcome: PassOutcome, onAsked: () => void) {
  return {
    ask_user: tool({
      description:
        "Ask the user something only they can answer. They answer on the Heads down page, maybe hours later; you don't wait. Their answer reaches a later pass. Give a streamId and that stream is marked waiting on them. Offer options when the answer is a choice, so it can be stored as a decision and reused.",
      inputSchema: z.object({
        question: z.string().min(1).max(1000),
        situation: z
          .string()
          .max(1000)
          .describe("What is going on, self-contained, so the answer can be reused later"),
        streamId: z.string().uuid().optional(),
        options: z.array(z.string().min(1).max(80)).max(6).optional(),
        action: z.string().max(100).optional().describe("The tool the question is about, if any"),
      }),
      execute: async ({ question, situation, streamId, options, action }) => {
        const asked = await askQuestion(db, {
          kind: "question",
          question,
          situation,
          streamId,
          options,
          action,
        });
        if (streamId) {
          await updateStream(db, streamId, { status: "waiting-on-user", waitingOn: question });
        }
        onAsked();
        return { questionId: asked.id, status: asked.status };
      },
    }),

    finish_pass: tool({
      description:
        "End the pass. Notes are for the next pass, which starts with no memory of this one: only what isn't already on the streams, tickets and PRs, short and direct. Ask for a sleep in minutes: short when there is work you can push soon, long when everything is waiting.",
      inputSchema: z.object({
        notes: z.string().max(2000).optional(),
        sleepMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
        reason: z.string().max(300).describe("Why that long, in a few words"),
      }),
      execute: async ({ notes, sleepMinutes, reason }) => {
        outcome.finished = true;
        outcome.notes = notes?.trim() || null;
        outcome.sleepMinutes = sleepMinutes;
        outcome.reason = reason;
        return { ok: true, message: "Pass recorded. Stop here." };
      },
    }),
  };
}
