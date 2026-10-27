import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AgentQuestionRow } from "../db/schema.ts";
import {
  ANSWER_WAIT_MS,
  askDescription,
  askInputShape,
  mayWaitOn,
  NO_SUCH_QUESTION,
  replyPayload,
  waitDescription,
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

/**
 * How long one call waits when the client sent a progress token: a day, the
 * same as a held permission prompt. Claude Code's own limit on a whole tool
 * call defaults to about 28 hours, so the reply arrives before it gives up.
 */
export const LONG_ANSWER_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * How often a long wait sends a progress notification. Claude Code drops an
 * HTTP tool call that sends nothing for five minutes, and Bun closes a socket
 * that is quiet for 255s (`server.ts`).
 */
const PROGRESS_INTERVAL_MS = 30_000;

/**
 * Most long waits held at once, overall and for one session. Each holds a
 * socket, and an agent looping on `wait_for_answer` could otherwise open them
 * until the sidecar runs out. Past either cap a call takes the short wait.
 */
const MAX_LONG_WAITS = 32;
const MAX_LONG_WAITS_PER_SESSION = 4;

/** Long waits running now, by asking session; sessionless clients share "". */
const longWaits = new Map<string, number>();
let longWaitTotal = 0;

const ASK_WAIT_GUIDANCE =
  "Usually blocks until the user answers, for up to a day. If it returns status 'pending' instead, pass the questionId to wait_for_answer to keep waiting.";

const WAIT_FOR_ANSWER_GUIDANCE =
  "Usually blocks until the user answers, for up to a day, then returns the answers, a decline, or 'pending' again.";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

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
  /** Overrides `PROGRESS_INTERVAL_MS`, so a test needn't wait 30s for a notification. */
  progressIntervalMs?: number;
}

/**
 * Waits for the user's reply. A client that sent a progress token gets a
 * progress notification every interval, which keeps the quiet call alive, so
 * it can wait `LONG_ANSWER_WAIT_MS`. Without one, or past the long-wait caps,
 * the call stays under the idle limits and the agent keeps waiting with
 * `wait_for_answer`.
 */
async function waitWithProgress(
  deps: QuestionToolDeps,
  id: string,
  extra: ToolExtra,
): Promise<AgentQuestionRow | undefined> {
  const progressToken = extra._meta?.progressToken;
  const session = deps.origin.sessionKey ?? "";
  const sessionWaits = longWaits.get(session) ?? 0;
  if (
    progressToken === undefined ||
    longWaitTotal >= MAX_LONG_WAITS ||
    sessionWaits >= MAX_LONG_WAITS_PER_SESSION
  ) {
    return deps.waitForReply(id, ANSWER_WAIT_MS);
  }
  longWaitTotal += 1;
  longWaits.set(session, sessionWaits + 1);

  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message: "Waiting for the user to answer" },
      })
      // A failed write means the client is gone; the request's own abort ends the wait.
      .catch(() => {});
  }, deps.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
  try {
    return await deps.waitForReply(id, LONG_ANSWER_WAIT_MS);
  } finally {
    clearInterval(timer);
    longWaitTotal -= 1;
    const left = (longWaits.get(session) ?? 1) - 1;
    if (left > 0) longWaits.set(session, left);
    else longWaits.delete(session);
  }
}

export function registerQuestionTools(server: McpServer, deps: QuestionToolDeps): void {
  server.registerTool(
    "ask_user",
    {
      title: "Ask the user",
      description: askDescription(
        "The user sees them in the Yarvis app, with your task and reason beside them, and can answer from wherever they are instead of switching to this session. Use it when you need a decision you can't make from the code or the request and would otherwise stop and wait.",
        ASK_WAIT_GUIDANCE,
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
    async ({ task, reason, questions }, extra) => {
      try {
        const row = await deps.ask({
          ...deps.origin,
          from: "coding-agent",
          context: { task, ...(reason ? { reason } : {}) },
          questions,
        });
        return jsonResult(replyPayload((await waitWithProgress(deps, row.id, extra)) ?? row));
      } catch (e) {
        return toolError("ask_user", e);
      }
    },
  );

  server.registerTool(
    "wait_for_answer",
    {
      title: "Wait for an answer",
      description: waitDescription(WAIT_FOR_ANSWER_GUIDANCE),
      inputSchema: waitInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ questionId }, extra) => {
      try {
        const asked = await deps.getQuestion(questionId);
        if (!asked || !mayWaitOn(asked, deps.origin.sessionKey)) {
          return callerError(NO_SUCH_QUESTION);
        }
        const row = await waitWithProgress(deps, questionId, extra);
        return jsonResult(replyPayload(row ?? asked));
      } catch (e) {
        return toolError("wait_for_answer", e);
      }
    },
  );
}
