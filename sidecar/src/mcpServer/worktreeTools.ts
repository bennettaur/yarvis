import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AddExtraWorktreeInput, WorktreeRefusal } from "../workspaces/service.ts";
import { callerError, jsonResult, toolError } from "./results.ts";

/**
 * Lets the agent session in a workspace add a worktree for another branch.
 * The session's sandbox can't run `git worktree add`, which writes to the
 * repo's shared clone, so Yarvis runs it and then widens the sandbox to that
 * one worktree and branch.
 */

/** Adds a worktree to one workspace; see `addExtraWorktree`. */
export type AddWorktree = (
  workspaceId: string,
  input: AddExtraWorktreeInput,
) => Promise<{ path: string; branch: string; startedFrom: string }>;

const MAX_NAME_LENGTH = 200;

export function registerWorktreeTools(
  server: McpServer,
  workspaceId: string,
  addWorktree: AddWorktree,
): void {
  server.registerTool(
    "add_worktree",
    {
      title: "Add a worktree",
      description:
        "Add a git worktree for another branch of one of this workspace's repos, inside the workspace folder. Use this instead of `git worktree add`, which fails in the sandbox. Commits, rebases and pushes in the new worktree then work from inside the sandbox. The branch must not exist locally: it is checked out from the remote when it is there, and otherwise cut from `base` (default: the workspace's base branch). Dependencies are not installed in the new worktree. Returns its path.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .max(MAX_NAME_LENGTH)
          .describe("The repo's folder in the workspace, or its name"),
        branch: z.string().min(1).max(MAX_NAME_LENGTH).describe("The branch to check out"),
        base: z
          .string()
          .min(1)
          .max(MAX_NAME_LENGTH)
          .optional()
          .describe("Remote branch to start a new branch from"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ repo, branch, base }) => {
      try {
        return jsonResult(await addWorktree(workspaceId, { repo, branch, base }));
      } catch (e) {
        if (e instanceof WorktreeRefusal) return callerError(e.message);
        return toolError("add_worktree", e);
      }
    },
  );
}
