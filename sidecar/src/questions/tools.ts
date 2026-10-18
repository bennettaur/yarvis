import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import {
  ANSWER_WAIT_MS,
  askDescription,
  askInputShape,
  mayRead,
  replyPayload,
  WAIT_DESCRIPTION,
  waitInputShape,
} from "./contract.ts";
import { askQuestions, getQuestion, waitForReply } from "./service.ts";

/**
 * `ask_user` and `wait_for_answer` for the in-app agent: the same pair a coding
 * session reaches over MCP, asking through the same bell and answer dialog. A
 * chat's questions are keyed to the chat, so they share one attention item and
 * only that chat can wait on them.
 */

/** The attention session key for a chat; null for a run with no chat, like a specialist. */
function chatSessionKey(sessionId: string): string | null {
  return sessionId ? `chat:${sessionId}` : null;
}

/** A failure the model can report, with the detail kept in the log. */
function failure(label: string, error: unknown) {
  console.error(`[questions] ${label} failed:`, describeError(error));
  return { error: `${label} failed — see the Yarvis sidecar log.` };
}

export function buildQuestionTools(db: Db, sessionId: string) {
  const sessionKey = chatSessionKey(sessionId);
  return {
    ask_user: tool({
      description: askDescription(
        "The user sees them in a dialog from the attention bell, wherever they are in the app. Use it when you need a decision to carry on with work and the user may not be watching this chat; when they are talking to you here, ask in your reply instead.",
      ),
      inputSchema: z.object(askInputShape),
      execute: async ({ task, reason, questions }, { abortSignal }) => {
        try {
          const row = await askQuestions(db, {
            from: "yarvis",
            sessionKey,
            workspaceId: null,
            context: { task, ...(reason ? { reason } : {}) },
            questions,
          });
          return replyPayload((await waitForReply(db, row.id, ANSWER_WAIT_MS, abortSignal)) ?? row);
        } catch (e) {
          return failure("ask_user", e);
        }
      },
    }),
    wait_for_answer: tool({
      description: WAIT_DESCRIPTION,
      inputSchema: z.object(waitInputShape),
      execute: async ({ questionId }, { abortSignal }) => {
        try {
          const asked = await getQuestion(db, questionId);
          if (!asked || !mayRead(asked, sessionKey)) return { error: "No question with that id." };
          const row = await waitForReply(db, questionId, ANSWER_WAIT_MS, abortSignal);
          return replyPayload(row ?? asked);
        } catch (e) {
          return failure("wait_for_answer", e);
        }
      },
    }),
  };
}
