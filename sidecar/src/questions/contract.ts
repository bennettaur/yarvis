import { z } from "zod";
import type { AgentQuestionRow } from "../db/schema.ts";

/**
 * What `ask_user` and `wait_for_answer` look like to the agent calling them.
 * Shared by the MCP tools a coding session reaches (`mcpServer/questionTools.ts`)
 * and the in-app agent's built-ins (`questions/tools.ts`), so the two stay
 * the same tool.
 */

/**
 * How long one call waits for a reply. Both callers stream over a connection
 * the server's `idleTimeout` (255s in `server.ts`) closes after that long with
 * nothing sent, so a wait that runs out returns `pending` and the agent calls
 * `wait_for_answer` to keep waiting.
 */
export const ANSWER_WAIT_MS = 240_000;

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("The choice as the user will see it, a few words"),
  description: z.string().max(300).optional().describe("What picking this means, or its trade-off"),
});

const questionSchema = z.object({
  question: z.string().min(1).max(1000).describe("The full question, ending with a question mark"),
  header: z
    .string()
    .max(40)
    .optional()
    .describe('A short tag shown above the question, like "Auth method"'),
  options: z
    .array(optionSchema)
    .min(2)
    .max(6)
    // Answers name the options they pick by label.
    .refine((options) => new Set(options.map((o) => o.label)).size === options.length, {
      message: "option labels must be unique",
    })
    .optional()
    .describe(
      "Choices to pick from. Leave out for a free-text question; the user can always add text.",
    ),
  multiSelect: z.boolean().optional().describe("Let the user pick more than one option"),
});

export const askInputShape = {
  task: z
    .string()
    .min(1)
    .max(500)
    .describe("What you are working on, in one sentence, so the user can answer without context"),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe("Why you need the user's input now, and what you'll do with the answer"),
  questions: z.array(questionSchema).min(1).max(4).describe("The questions, asked together"),
};

export const waitInputShape = {
  questionId: z
    .string()
    .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid")
    .describe("The questionId ask_user returned"),
};

export const WAIT_DESCRIPTION =
  "Keep waiting for the user's answer to an earlier ask_user call that returned status 'pending'. Blocks for up to four minutes, then returns the answers, a decline, or 'pending' again.";

/** The one wording a tool may have to itself: where the user sees the question. */
export function askDescription(whereUserIs: string): string {
  return `Ask the user one or more questions and wait for their answers. ${whereUserIs} Never ask for passwords, tokens, keys or other secrets. Blocks for up to four minutes; if the user hasn't answered by then it returns status 'pending' and a questionId to pass to wait_for_answer.`;
}

/**
 * What the agent gets back: the answers, a decline, or a pointer to keep
 * waiting. The answers are not fenced as untrusted text, unlike recalled
 * memories: only the user can write them (the answer route sits behind the main
 * bearer), and they are the user's own direction to the agent.
 */
export function replyPayload(row: AgentQuestionRow) {
  switch (row.status) {
    case "answered":
      return {
        status: "answered" as const,
        answers: row.questions.map((q, i) => {
          const answer = row.answers?.[i];
          return {
            question: q.question,
            selected: answer?.selected ?? [],
            ...(answer?.text ? { text: answer.text } : {}),
          };
        }),
      };
    case "declined":
      return {
        status: "declined" as const,
        message:
          "The user chose not to answer. Proceed on your own judgement, or stop and explain what you need.",
      };
    case "pending":
      return {
        status: "pending" as const,
        questionId: row.id,
        message:
          "The user hasn't answered yet. Call wait_for_answer with this questionId to keep waiting, or carry on with work that doesn't depend on the answer and check back later.",
      };
  }
}

/** Whether `sessionKey` may read the answers to `row`: its own, or a sessionless one. */
export function mayRead(row: AgentQuestionRow, sessionKey: string | null): boolean {
  return !row.sessionKey || row.sessionKey === sessionKey;
}
