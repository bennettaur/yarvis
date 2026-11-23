import { tool } from "ai";
import { z } from "zod";
import { navTargetSchema } from "../attention/navTarget.ts";
import { raiseAttention } from "../attention/raise.ts";
import type { Db } from "../db/client.ts";
import { ATTENTION_CATEGORIES } from "../db/schema.ts";

/**
 * Per-request attention state. The route creates a fresh one for each chat turn,
 * passes it to {@link buildAttentionTools}, and reads it after the stream
 * completes to decide whether to surface an `attention` event to the client.
 */
export interface AttentionState {
  requested: boolean;
  reason: string | null;
}

export function newAttentionState(): AttentionState {
  return { requested: false, reason: null };
}

/**
 * The attention tools.
 *
 * `request_attention` calls the user back to this conversation: the captured
 * reason is read after the stream ends and surfaced to the client, which
 * raises a notification.
 *
 * `raise_attention` puts an item in the attention bell, where it waits until
 * the user deals with it. Heads-down passes and specialists use it too, since
 * nobody is watching their conversation.
 */
export function buildAttentionTools(state: AttentionState, db: Db) {
  return {
    request_attention: tool({
      description:
        "Signal that you need the user's attention. Call this when you've finished work they asked for in the background, or they should come back to read something. It raises a notification so they can return to this chat. To get a decision from them, use ask_user instead. Provide a short reason.",
      inputSchema: z.object({
        reason: z
          .string()
          .min(1)
          .max(200)
          .describe("A short summary of why you need the user, shown in the notification"),
      }),
      execute: async ({ reason }) => {
        state.requested = true;
        state.reason = reason;
        return { acknowledged: true };
      },
    }),

    raise_attention: tool({
      description:
        "Put an item in the user's attention bell. Use kind 'action' for something only the user can do (review a PR, approve a deploy, unblock a stream) and kind 'message' to tell them something they only need to read, such as a finished check or what you found. Don't raise work that is merely in progress. Give a dedupeKey naming the thing (e.g. 'pr:owner/repo#12') so raising it again updates the item instead of adding another. Put third-party text, such as PR titles or message excerpts, in body, never title.",
      inputSchema: z.object({
        category: z
          .enum(ATTENTION_CATEGORIES)
          .describe(
            "review: someone else's PR. build: the user's own code, PRs, CI, deploys. slack: a chat message. general: anything else",
          ),
        kind: z.enum(["action", "message"]),
        title: z.string().min(1).max(120).describe("A short heading in your own words"),
        body: z.string().max(2000).optional().describe("The detail"),
        navTarget: navTargetSchema
          .optional()
          .describe("Where clicking the item takes the user: the PR, workspace or chat to act in"),
        dedupeKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Names what the item is about, so re-raising it updates the same item"),
      }),
      execute: async (input) => {
        const item = await raiseAttention(db, { ...input, source: "chat-agent" });
        return { id: item.id };
      },
    }),
  };
}
