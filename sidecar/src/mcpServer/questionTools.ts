import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentQuestionRow } from "../db/schema.ts";
import {
  ANSWER_WAIT_MS,
  askDescription,
  askInputShape,
  mayWaitOn,
  NO_SUCH_QUESTION,
  replyPayload,
  WAIT_DESCRIPTION,
  waitInputShape,
} from "../questions/contract.ts";
import type { AskInput } from "../questions/service.ts";
import { callerError, jsonResult, toolError } from "./results.ts";

/**
 * The question tools Yarvis serves over MCP. A coding agent calls `ask_user`
 * when it needs a decision; the user gets a bell and answers in a dialog from
 * the attention panel, wherever they are in the app, instead of switching to
 * the agent's terminal. The in-app agent has the same pair as built-ins
 * (`questions/tools.ts`).
 */

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

export function registerQuestionTools(server: McpServer, deps: QuestionToolDeps): void {
  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description: askDescription(
        "The user sees them in the Yarvis app, with your task and reason beside them, and can answer from wherever they are instead of switching to this session. Use it when you need a decision you can't make from the code or the request and would otherwise stop and wait.",
      ),
      inputSchema: askInputShape,
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
          from: "coding-agent",
          context: { task, ...(reason ? { reason } : {}) },
          questions,
        });
        return jsonResult(replyPayload((await deps.waitForReply(row.id, ANSWER_WAIT_MS)) ?? row));
      } catch (e) {
        return toolError("ask_user", e);
      }
    },
  );

  server.registerTool(
    "wait_for_answer",
    {
      title: "Wait for an answer",
      description: WAIT_DESCRIPTION,
      inputSchema: waitInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ questionId }) => {
      try {
        const asked = await deps.getQuestion(questionId);
        if (!asked || !mayWaitOn(asked, deps.origin.sessionKey)) {
          return callerError(NO_SUCH_QUESTION);
        }
        const row = await deps.waitForReply(questionId, ANSWER_WAIT_MS);
        return jsonResult(replyPayload(row ?? asked));
      } catch (e) {
        return toolError("wait_for_answer", e);
      }
    },
  );
}
