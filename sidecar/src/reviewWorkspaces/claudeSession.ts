/**
 * An interactive Claude Code session in a review PR's checkout, for asking
 * questions about the PR. The user drives it in a tab; the core owns the PTY.
 *
 * The checkout is code the PR's author wrote, so the session gets the same
 * settings the headless review runs get (`lockedDownSettings`): no settings
 * file from the checkout or the user, no hooks, no MCP servers, Bash in a
 * sandbox with no network, and the home folder's credentials unreadable. On top
 * of that it can't edit files, since its job is answering questions. The core
 * adds `--setting-sources ''` and a guardrail prompt when it builds the launch
 * line (`spawn_review_claude_session` in `src-tauri/src/pty.rs`).
 */

import { lockedDownSettings } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import { hasCoreChannel, spawnReviewClaudeSession } from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import { getReviewPr, ReviewWorkspaceError } from "./service.ts";
import { requireCheckout } from "./verification.ts";

const DENIED_EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

/** The settings a review session runs with: the review runs' lockdown, minus edits. */
function reviewSessionSettings(): Record<string, unknown> {
  const settings = lockedDownSettings();
  const permissions = settings.permissions as { deny: string[] };
  return {
    ...settings,
    permissions: { ...permissions, deny: [...permissions.deny, ...DENIED_EDIT_TOOLS] },
  };
}

/** The PTY id the core gives a review PR's session; matches `REVIEW_CLAUDE_PREFIX` in `pty.rs`. */
export const reviewClaudeSessionId = (prId: string) => `review-claude:${prId}`;

export interface ReviewClaudeDeps {
  spawn: typeof spawnReviewClaudeSession;
  hasCore: () => boolean;
}

export const defaultReviewClaudeDeps: ReviewClaudeDeps = {
  spawn: spawnReviewClaudeSession,
  hasCore: hasCoreChannel,
};

/**
 * Starts the PR's session, or leaves the one already running alone (the core
 * discards a spawn whose id is taken). Answers with the session's PTY id for
 * the frontend to attach to.
 */
export async function startReviewClaudeSession(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewClaudeDeps = defaultReviewClaudeDeps,
): Promise<{ sessionId: string }> {
  if (!deps.hasCore()) {
    throw new ReviewWorkspaceError(
      "the app's core isn't running, so it can't start a session",
      503,
    );
  }
  const pr = await getReviewPr(db, workspaceId, prId);
  requireCheckout(config, pr);

  try {
    await deps.spawn({
      prId: pr.id,
      cwd: pr.worktreePath,
      settings: JSON.stringify(reviewSessionSettings()),
    });
  } catch (e) {
    // The core refuses for reasons the user can act on (the agent isn't Claude
    // Code, too many terminals open), so its message is the answer.
    throw new ReviewWorkspaceError(describeError(e), 502);
  }
  return { sessionId: reviewClaudeSessionId(pr.id) };
}
