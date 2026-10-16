import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentQuestionRow } from "../db/schema.ts";
import type { AskInput } from "../questions/service.ts";
import { jsonResult, toolError, toolMessage } from "./toolResults.ts";

/**
 * The question tools Yarvis serves over MCP. A coding agent calls `ask_user`
 * when it needs a decision; the user gets a bell and answers in a dialog from
 * the attention panel, wherever they are in the app, instead of switching to
 * the agent's terminal.
 */

/**
 * How long one call holds the connection waiting for a reply. It must stay under
 * the server's `idleTimeout` (255s in `server.ts`), which closes a connection
 * that has sent nothing for that long. A wait that runs out returns `pending`
 * and the agent calls `wait_for_answer` to keep waiting.
 */
const ANSWER_WAIT_MS = 240_000;

const UUID = z
  .string()
  .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid");

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

/** Where an MCP request came from, read from the headers a workspace's `.mcp.json` sets. */
export interface QuestionOrigin {
  sessionKey: string | null;
  workspaceId: string | null;
}

/** The storage the tools need, injected so the routes can bind it to a database. */
export interface QuestionToolDeps {
  origin: QuestionOrigin;
  ask(input: AskInput): Promise<AgentQuestionRow>;
  getQuestion(id: string): Promise<AgentQuestionRow | undefined>;
  waitForReply(id: string, timeoutMs: number): Promise<AgentQuestionRow | undefined>;
}

/** What the agent gets back: the answers, a decline, or a pointer to keep waiting. */
// The answers are not fenced as untrusted text, unlike recalled memories: only
// the user can write them (the answer route sits behind the main bearer), and
// they are the user's own direction to the agent.
function toolResultFor(row: AgentQuestionRow) {
  switch (row.status) {
    case "answered":
      return jsonResult({
        status: "answered",
        answers: row.questions.map((q, i) => {
          const answer = row.answers?.[i];
          return {
            question: q.question,
            selected: answer?.selected ?? [],
            ...(answer?.text ? { text: answer.text } : {}),
          };
        }),
      });
    case "declined":
      return jsonResult({
        status: "declined",
        message:
          "The user chose not to answer. Proceed on your own judgement, or stop and explain what you need.",
      });
    case "pending":
      return jsonResult({
        status: "pending",
        questionId: row.id,
        message:
          "The user hasn't answered yet. Call wait_for_answer with this questionId to keep waiting, or carry on with work that doesn't depend on the answer and check back later.",
      });
  }
}

export function registerQuestionTools(server: McpServer, deps: QuestionToolDeps): void {
  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description:
        "Ask the user one or more questions and wait for their answers. The user sees them in the Yarvis app, with your task and reason beside them, and can answer from wherever they are instead of switching to this session. Use it when you need a decision you can't make from the code or the request and would otherwise stop and wait. Never ask for passwords, tokens, keys or other secrets. Blocks for up to four minutes; if the user hasn't answered by then it returns status 'pending' and a questionId to pass to wait_for_answer.",
      inputSchema: {
        task: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "What you are working on, in one sentence, so the user can answer without opening this session",
          ),
        reason: z
          .string()
          .max(1000)
          .optional()
          .describe("Why you need the user's input now, and what you'll do with the answer"),
        questions: z.array(questionSchema).min(1).max(4).describe("The questions, asked together"),
      },
      // Not read-only: it stores the question and rings the bell.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ task, reason, questions }) => {
      try {
        const row = await deps.ask({
          ...deps.origin,
          context: { task, ...(reason ? { reason } : {}) },
          questions,
        });
        return toolResultFor((await deps.waitForReply(row.id, ANSWER_WAIT_MS)) ?? row);
      } catch (e) {
        return toolError("ask_user", e);
      }
    },
  );

  server.registerTool(
    "wait_for_answer",
    {
      title: "Wait for an answer",
      description:
        "Keep waiting for the user's answer to an earlier ask_user call that returned status 'pending'. Blocks for up to four minutes, then returns the answers, a decline, or 'pending' again.",
      inputSchema: {
        questionId: UUID.describe("The questionId ask_user returned"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ questionId }) => {
      try {
        // A session reads only its own questions' answers. A question from a
        // client Yarvis didn't launch has no session, so any caller may wait on it.
        const asked = await deps.getQuestion(questionId);
        if (!asked || (asked.sessionKey && asked.sessionKey !== deps.origin.sessionKey)) {
          return toolMessage("No question with that id.");
        }
        const row = await deps.waitForReply(questionId, ANSWER_WAIT_MS);
        return toolResultFor(row ?? asked);
      } catch (e) {
        return toolError("wait_for_answer", e);
      }
    },
  );
}
