import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkspaceReviewComment } from "../db/schema.ts";
import type { LocatedReviewComment } from "../workspaces/reviewComments.ts";
import { jsonResult, toolError, UUID, userError } from "./results.ts";

/**
 * The self-review comments the user left on a workspace's diffs, served over
 * MCP so the agent session working in that workspace can read the feedback and
 * mark each note resolved once it has addressed it.
 *
 * Every call is scoped to the one workspace the session belongs to. The
 * session names it in a header its `.mcp.json` carries, so the tools have no
 * workspace argument for a model to fill in.
 */

/** Reads and resolves one workspace's review comments. */
export interface ReviewCommentStore {
  list(workspaceId: string): Promise<LocatedReviewComment[]>;
  /** Null when the comment isn't in this workspace. */
  setResolved(
    workspaceId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<WorkspaceReviewComment | null>;
}

export function registerReviewCommentTools(
  server: McpServer,
  workspaceId: string,
  store: () => ReviewCommentStore,
): void {
  server.registerTool(
    "list_review_comments",
    {
      title: "List review comments",
      description:
        "Read the review comments the user left in Yarvis on this workspace's diffs. Open comments are feedback to address. Each comment's path is relative to its worktreePath, and its lines are new-file line numbers at commitSha, so re-read the file when it has changed since. Once a comment is addressed, mark it with resolve_review_comment.",
      inputSchema: {
        includeResolved: z
          .boolean()
          .optional()
          .describe("Also return comments already marked resolved (default false)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ includeResolved }) => {
      try {
        const comments = await store().list(workspaceId);
        // Bodies go out unfenced: only the user writes these, through the app,
        // and acting on them is the point of the tool.
        return jsonResult({
          comments: comments
            .filter((c) => includeResolved || c.resolvedAt === null)
            .map((c) => ({
              id: c.id,
              repo: c.repoName,
              worktreePath: c.worktreePath,
              path: c.path,
              startLine: c.startLine,
              endLine: c.endLine,
              commitSha: c.commitSha,
              resolved: c.resolvedAt !== null,
              createdAt: c.createdAt.toISOString(),
              body: c.body,
            })),
        });
      } catch (e) {
        return toolError("list_review_comments", e);
      }
    },
  );

  server.registerTool(
    "resolve_review_comment",
    {
      title: "Resolve a review comment",
      description:
        "Mark one of this workspace's review comments resolved after addressing it, or reopen it with resolved: false. Ids come from list_review_comments.",
      inputSchema: {
        id: UUID.describe("Id of the review comment"),
        resolved: z
          .boolean()
          .optional()
          .describe("False reopens a resolved comment (default true)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ id, resolved }) => {
      try {
        const updated = await store().setResolved(workspaceId, id, resolved ?? true);
        if (!updated) return userError(`No review comment ${id} in this workspace.`);
        return jsonResult({ id: updated.id, resolved: updated.resolvedAt !== null });
      } catch (e) {
        return toolError("resolve_review_comment", e);
      }
    },
  );
}
