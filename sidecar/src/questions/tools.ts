import { tool } from "ai";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import {
  ANSWER_WAIT_MS,
  askDescription,
  askInputShape,
  mayWaitOn,
  NO_SUCH_QUESTION,
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

/**
 * The attention session key for a chat. Delegated runs never get these tools,
 * so an empty id only comes from the registry's metadata build.
 */
function chatSessionKey(sessionId: string): string | null {
  return sessionId ? `chat:${sessionId}` : null;
}

/**
 * Keeps database errors out of the model's context, as the MCP tools do: a
 * failed query carries its SQL and parameters, which may include the user's answers.
 */
function failure(label: string, error: unknown) {
  console.error(`[questions] ${label} failed:`, describeError(error));
  return { error: `${label} failed — see the Yarvis sidecar log.` };
}

/**
 * A chat turn ends when the model replies, and the next turn replays only the
 * conversation text, so a question still pending then has nobody to read its
 * answer.
 */
const CHAT_PENDING_MESSAGE =
  "The user hasn't answered yet. Call wait_for_answer with this questionId to keep waiting. If you reply instead, a later turn can't pick the answer up, so tell the user to answer you here in the chat.";

/** Away from the app, as on Telegram, nobody can see the bell to answer it. */
const AWAY_FROM_APP =
  "The user is away from the Yarvis app and can't see the question there. Ask in your reply instead.";

export function buildQuestionTools(db: Db, sessionId: string, { atTheApp }: { atTheApp: boolean }) {
  const sessionKey = chatSessionKey(sessionId);
  return {
    ask_user: tool({
      description: askDescription(
        "The user sees them in a dialog from the attention bell, wherever they are in the app. Use it when you need a decision to carry on with work and the user may not be watching this chat; when they are talking to you here, ask in your reply instead.",
      ),
      inputSchema: z.object(askInputShape),
      execute: async ({ task, reason, questions }, { abortSignal }) => {
        if (!atTheApp) return { error: AWAY_FROM_APP };
        try {
          const row = await askQuestions(db, {
            from: "yarvis",
            sessionKey,
            workspaceId: null,
            context: { task, ...(reason ? { reason } : {}) },
            questions,
          });
          const reply = await waitForReply(db, row.id, ANSWER_WAIT_MS, abortSignal);
          return replyPayload(reply ?? row, CHAT_PENDING_MESSAGE);
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
          if (!asked || !mayWaitOn(asked, sessionKey)) return { error: NO_SUCH_QUESTION };
          const row = await waitForReply(db, questionId, ANSWER_WAIT_MS, abortSignal);
          return replyPayload(row ?? asked, CHAT_PENDING_MESSAGE);
        } catch (e) {
          return failure("wait_for_answer", e);
        }
      },
    }),
  };
}
