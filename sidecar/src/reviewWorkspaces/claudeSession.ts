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

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedDownSettings } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import { hasCoreChannel, spawnReviewClaudeSession } from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { sweepContextDirs } from "./agentContext.ts";
import { getReviewPr, ReviewWorkspaceError } from "./service.ts";
import { requireCheckout } from "./verification.ts";

export const REVIEW_CLAUDE_SETTINGS_PREFIX = "yarvis-review-claude-";

/**
 * How long a session's settings folder is kept. Claude Code reads the file once
 * at launch, so this only has to outlast the launch, but a day keeps the
 * folder there for a session the user restarts from its shell.
 */
const SETTINGS_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const NO_EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

/** The settings a review session runs with: the review runs' lockdown, minus edits. */
export function reviewSessionSettings(home?: string): Record<string, unknown> {
  const settings = lockedDownSettings(home);
  const permissions = settings.permissions as { deny: string[] };
  return { ...settings, permissions: { deny: [...permissions.deny, ...NO_EDIT_TOOLS] } };
}

/** The PTY id the core gives a review PR's session. */
export const reviewClaudeSessionId = (prId: string) => `review-claude:${prId}`;

export interface ReviewClaudeDeps {
  spawn: typeof spawnReviewClaudeSession;
  hasCore: () => boolean;
  /** Where settings folders are made; the system temp folder by default. */
  tmpRoot?: string;
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

  const root = deps.tmpRoot ?? tmpdir();
  sweepContextDirs({
    prefix: REVIEW_CLAUDE_SETTINGS_PREFIX,
    maxAgeMs: SETTINGS_DIR_MAX_AGE_MS,
    root,
  });
  // A fresh folder each time, so nothing a session wrote under the temp folder
  // can stand in for the file the next one reads.
  const dir = mkdtempSync(join(root, REVIEW_CLAUDE_SETTINGS_PREFIX));
  chmodSync(dir, 0o700);
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(reviewSessionSettings()), { mode: 0o600, flag: "wx" });

  await deps.spawn({ prId: pr.id, cwd: pr.worktreePath, settingsPath });
  return { sessionId: reviewClaudeSessionId(pr.id) };
}
