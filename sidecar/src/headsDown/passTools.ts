import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { getStream, updateStream } from "../workStreams/service.ts";
import { STREAM_PAUSED } from "../workStreams/tools.ts";
import { announceMerge, askUser, mergeKey } from "./attention.ts";

/**
 * The tools only a heads-down pass has: asking the user without waiting for
 * them, telling them about a merge, and ending the pass with notes and a
 * sleep length.
 */

/** What `finish_pass` asked for, read by the loop once the pass is over. */
export interface PassOutcome {
  finished: boolean;
  notes: string | null;
  sleepMinutes: number | null;
  reason: string | null;
  /** Routines offered this pass that it reported done. */
  routinesDone: string[];
}

export function newPassOutcome(): PassOutcome {
  return { finished: false, notes: null, sleepMinutes: null, reason: null, routinesDone: [] };
}

/**
 * `announcedMerges` collects the PRs this pass announced (see `mergeKey`), so
 * the approval hooks can tell a merge it didn't announce. `offeredRoutines`
 * names the routines this pass was given; `finish_pass` records only those.
 */
export function buildPassTools(
  db: Db,
  outcome: PassOutcome,
  onAsked: () => void,
  announcedMerges: Set<string>,
  offeredRoutines: readonly string[],
) {
  return {
    announce_merge: tool({
      description:
        "Call when a merge can go ahead now, right before you merge the PR, whether with a tool or by telling a workspace's session to. Not while the merge still waits on the user's approval: announce it on the pass that makes it. It pops up an alert over whatever the user has open; it doesn't merge anything or wait for them. Judge the risk from the files the PR changes first, and ask with ask_user instead when it is high or you can't tell.",
      inputSchema: z.object({
        repo: z
          .string()
          .regex(/^[\w.-]+\/[\w.-]+$/)
          .describe("The PR's repo, as owner/name"),
        number: z.number().int().positive(),
        title: z.string().max(300).optional().describe("The PR's title"),
        risk: z.enum(["low", "medium", "high"]),
        why: z
          .string()
          .min(1)
          .max(500)
          .describe("Why you are merging it now, and why that risk level"),
      }),
      execute: async (merge) => {
        // Added before the alert is written, so a merge call made in the same
        // step finds it and the backstop doesn't raise a second alert.
        announcedMerges.add(mergeKey(merge.repo, merge.number));
        await announceMerge(db, merge);
        return { ok: true, message: "The user has been shown this merge." };
      },
    }),

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
        if (streamId) {
          const stream = await getStream(db, streamId);
          if (!stream) return { error: "no work stream with that id" };
          if (stream.pausedAt) return { error: STREAM_PAUSED };
        }
        const asked = await askUser(db, {
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
        routinesDone: z
          .array(z.string().max(64))
          .max(20)
          .optional()
          .describe(
            "Names of the routines given to this pass that you finished, including ones that turned out to have nothing to do",
          ),
      }),
      execute: async ({ notes, sleepMinutes, reason, routinesDone }) => {
        outcome.finished = true;
        outcome.notes = notes?.trim() || null;
        outcome.sleepMinutes = sleepMinutes;
        outcome.reason = reason;
        // A name the pass wasn't given would push that routine's next run back unseen.
        const reported = [...new Set(routinesDone ?? [])];
        outcome.routinesDone = reported.filter((name) => offeredRoutines.includes(name));
        const ignored = reported.filter((name) => !offeredRoutines.includes(name));
        if (ignored.length > 0) {
          return {
            ok: true,
            message: `Pass recorded. Not recorded as done, since this pass wasn't given them: ${ignored.join(", ")}. Stop here.`,
          };
        }
        return { ok: true, message: "Pass recorded. Stop here." };
      },
    }),
  };
}
