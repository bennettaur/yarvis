import { tool } from "ai";
import { z } from "zod";

/**
 * Per-request attention state. The route creates a fresh one for each chat turn,
 * passes it to {@link buildAttentionTool}, and reads it after the stream
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
 * The `request_attention` tool. The chat model calls it when it needs the user
 * to come back to the conversation — for example after finishing work they
 * asked for while the quick-chat overlay was hidden, or when it needs a decision
 * only the user can make. The captured reason is read after the stream ends and
 * surfaced to the client, which raises a notification.
 */
export function buildAttentionTool(state: AttentionState) {
  return {
    request_attention: tool({
      description:
        "Signal that you need the user's attention. Call this when you've finished work they asked for in the background, or you need a decision only they can make. It raises a notification so they can return to this chat. Provide a short reason.",
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
  };
}
