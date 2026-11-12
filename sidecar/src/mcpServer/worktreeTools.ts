import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  type AddExtraWorktreeInput,
  type AddExtraWorktreeResult,
  WorktreeRefusal,
} from "../workspaces/extraWorktree.ts";
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
) => Promise<AddExtraWorktreeResult>;

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
      description: [
        "Add a git worktree for another branch of one of this workspace's repos, inside the workspace folder, at `<repo folder>-<branch>` with `/` in the branch turned into `-`.",
        "Use this instead of `git worktree add`, which fails in the sandbox. This tool widens the sandbox to the new worktree and its branch, so commits, rebases and pushes there work from inside it.",
        "The branch must not exist in the local clone, in any letter case: pick a new name if it does.",
        "If the branch is on the remote, it is checked out from there, and `base` must be left out.",
        "Otherwise a new branch is cut from `base`, or from the workspace's base branch.",
        "No setup script runs and no dependencies are installed in the new worktree.",
        "Returns `path`, `branch` and `startedFrom` (the remote branch it came from).",
      ].join(" "),
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
