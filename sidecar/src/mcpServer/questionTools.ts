import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentQuestionRow } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import type { AskInput } from "../questions/service.ts";

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
export const ANSWER_WAIT_MS = 240_000;

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
  waitForReply(id: string, timeoutMs: number): Promise<AgentQuestionRow | undefined>;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** A tool failure the caller can act on, with the detail kept in the logs. */
function toolError(label: string, error: unknown) {
  console.error(`[mcp] ${label} failed:`, describeError(error));
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${label} failed — see the Yarvis sidecar log.` }],
  };
}

/** What the agent gets back: the answers, a decline, or a pointer to keep waiting. */
export function replyResult(row: AgentQuestionRow) {
  switch (row.status) {
    case "answered":
      return jsonResult({
        status: "answered",
        answers: row.questions.map((q, i) => ({
          question: q.question,
          selected: row.answers?.[i]?.selected ?? [],
          ...(row.answers?.[i]?.text ? { text: row.answers[i]!.text } : {}),
        })),
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
          "The user hasn't answered yet. Call wait_for_answer with this questionId to keep waiting.",
      });
  }
}

export function registerQuestionTools(server: McpServer, deps: QuestionToolDeps): void {
  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description:
        "Ask the user one or more questions and wait for their answers. The user sees them in the Yarvis app, with your task and reason beside them, and can answer without switching to this session. Use it when you need a decision you can't make from the code or the request. Blocks for up to four minutes; if the user hasn't answered by then it returns status 'pending' and a questionId to pass to wait_for_answer.",
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
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ task, reason, questions }) => {
      try {
        const row = await deps.ask({
          ...deps.origin,
          context: { task, ...(reason ? { reason } : {}) },
          questions,
        });
        return replyResult((await deps.waitForReply(row.id, ANSWER_WAIT_MS)) ?? row);
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
        const row = await deps.waitForReply(questionId, ANSWER_WAIT_MS);
        if (!row) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No question with that id." }],
          };
        }
        return replyResult(row);
      } catch (e) {
        return toolError("wait_for_answer", e);
      }
    },
  );
}
