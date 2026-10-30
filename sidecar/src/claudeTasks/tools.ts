import { tool } from "ai";
import { z } from "zod";
import type { ClaudeRunDeps } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { getClaudeTask, MAX_TASK_CHARS, MAX_TITLE_CHARS, startClaudeTask } from "./service.ts";

export function buildClaudeTaskTools(
  db: Db,
  config: Config,
  sessionId: string,
  runDeps: ClaudeRunDeps = {},
) {
  return {
    start_claude_code_task: tool({
      description:
        "Hand a self-contained piece of work to Claude Code, running in the background in a fresh empty folder, without starting a workspace. Use it for things that are easier to build than to write in chat: a small website or interactive page, a formatted brief or report, a script, a data file. It has no network access and can't see the user's repos, so put everything it needs in the task. It runs for up to 30 minutes; the user gets a notification when it is done, and get_claude_code_task returns its summary and files. For changes to one of the user's repos, start a workspace session instead.",
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(MAX_TITLE_CHARS)
          .describe("A few words naming the task, shown in the notification"),
        task: z
          .string()
          .min(1)
          .max(MAX_TASK_CHARS)
          .describe(
            "Self-contained instructions: what to make, who it is for, the content it needs, and the form it should take (e.g. a single index.html)",
          ),
      }),
      execute: async ({ title, task }) => {
        try {
          const started = await startClaudeTask(
            db,
            config,
            { title, task, chatSessionId: sessionId || null },
            runDeps,
          );
          return { ...started, status: "running" };
        } catch (e) {
          return { error: `could not start Claude Code: ${e instanceof Error ? e.message : e}` };
        }
      },
    }),

    get_claude_code_task: tool({
      description:
        "Check on a task started with start_claude_code_task: whether it is still running, and once it is done, its summary, the files it made (absolute folder plus relative paths) and what it cost.",
      inputSchema: z.object({ runId: z.string().uuid() }),
      execute: async ({ runId }) => {
        const found = await getClaudeTask(db, runId);
        return found ?? { error: "no Claude Code task with that id" };
      },
    }),
  };
}
