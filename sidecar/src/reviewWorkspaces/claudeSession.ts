/**
 * An interactive Claude Code session for a review workspace, for asking
 * questions about its PRs. One session covers every PR checked out in the
 * workspace, so it can answer across a stack. The user drives it in a tab; the
 * core owns the PTY.
 *
 * The checkouts are code the PRs' authors wrote, so the session gets the same
 * settings the headless review runs get (`lockedDownSettings`): no settings
 * file from a checkout or the user, no hooks, no MCP servers, Bash in a
 * sandbox with no network, and the home folder's credentials unreadable. On top
 * of that it can't edit files, since its job is answering questions. The core
 * adds `--setting-sources ''` and a guardrail prompt when it builds the launch
 * line (`spawn_review_claude_session` in `src-tauri/src/pty.rs`).
 *
 * The launch line is typed into the user's login shell, whose hooks (mise,
 * direnv, a dotenv plugin) act on the folder it starts in and that folder's
 * parents. So the shell starts in a folder of Yarvis's own, emptied before
 * every start, and the checkouts reach the session as `--add-dir`s.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { lockedDownSettings } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import {
  hasCoreChannel,
  killReviewClaudeSession,
  spawnReviewClaudeSession,
} from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import {
  assertWorktreeInWorkspace,
  getReviewWorkspace,
  ReviewWorkspaceError,
  reviewSessionFolder,
  withClaudeSessionLock,
} from "./service.ts";

/** The most checkouts one session reads; matches `MAX_REVIEW_DIRS` in `pty.rs`. */
const MAX_SESSION_PRS = 20;

/**
 * Tools the session never needs. The edit tools because it answers questions.
 * `Skill` because a checkout added with `--add-dir` may ship its own skills,
 * whose frontmatter can pre-approve tools.
 */
const DENIED_TOOLS = ["Write", "Edit", "NotebookEdit", "Skill"];

/**
 * The settings a review session runs with: the review runs' lockdown, minus
 * edits and skills. Sandboxed commands also can't write to any checkout, so
 * one PR's code can't change another's, which a later setup run would execute,
 * nor to the session's own folder, which the next session's shell opens in.
 */
function reviewSessionSettings(
  sessionFolder: string,
  checkouts: string[],
): Record<string, unknown> {
  const settings = lockedDownSettings();
  const permissions = settings.permissions as { deny: string[] };
  const sandbox = settings.sandbox as { filesystem: Record<string, unknown> };
  return {
    ...settings,
    permissions: { ...permissions, deny: [...permissions.deny, ...DENIED_TOOLS] },
    sandbox: {
      ...sandbox,
      filesystem: { ...sandbox.filesystem, denyWrite: [sessionFolder, ...checkouts] },
    },
  };
}

/** The PTY id the core gives a workspace's session; matches `review_session_id` in `pty.rs`. */
const reviewClaudeSessionId = (workspaceId: string) => `review-claude:${workspaceId}`;

/**
 * The folder a workspace's session starts in, emptied first. The session's
 * sandboxed commands can't write there, but anything else that did (a
 * `mise.toml`, an `.envrc`) is removed before the next shell starts in it. It
 * keeps its path, since Claude Code remembers folder trust by path.
 */
function freshSessionFolder(config: Config, workspaceId: string): string {
  const real = reviewSessionFolder(
    { workspacesRoot: realpathSync(config.workspacesRoot) },
    workspaceId,
  );
  const dir = reviewSessionFolder(config, workspaceId);
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  // A link in its place would send the shell somewhere else.
  if (lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === false)
    rmSync(dir, { force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Checked again before anything is removed: a link swapped in for either
  // folder would point the emptying below at whatever it names.
  if (realpathSync(dir) !== real) {
    throw new Error(`${dir} is not a plain folder; left in place`);
  }
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
  return real;
}

export interface ReviewClaudeDeps {
  spawn: typeof spawnReviewClaudeSession;
  kill: typeof killReviewClaudeSession;
  hasCore: () => boolean;
}

export const defaultReviewClaudeDeps: ReviewClaudeDeps = {
  spawn: spawnReviewClaudeSession,
  kill: killReviewClaudeSession,
  hasCore: hasCoreChannel,
};

/**
 * Starts the workspace's session over every PR whose checkout is ready, or
 * leaves the one already running alone (the core discards a spawn whose id is
 * taken; its folder is still emptied, which a running session can't write to).
 * A PR checked out later joins on the next start. Answers with the session's
 * PTY id. Runs under the workspace's session lock, so it can't start a session
 * between a removal ending the old one and deleting a checkout.
 */
export async function startReviewClaudeSession(
  db: Db,
  config: Config,
  workspaceId: string,
  deps: ReviewClaudeDeps = defaultReviewClaudeDeps,
): Promise<{ sessionId: string }> {
  if (!deps.hasCore()) {
    throw new ReviewWorkspaceError(
      "the app's core isn't running, so it can't start a session",
      503,
    );
  }
  return withClaudeSessionLock(workspaceId, () => startLocked(db, config, workspaceId, deps));
}

async function startLocked(
  db: Db,
  config: Config,
  workspaceId: string,
  deps: ReviewClaudeDeps,
): Promise<{ sessionId: string }> {
  const ws = await getReviewWorkspace(db, workspaceId);
  if (!ws) throw new ReviewWorkspaceError("review workspace not found", 404);
  if (ws.status !== "active") {
    throw new ReviewWorkspaceError(`review workspace is ${ws.status}`, 409);
  }
  const ready = ws.prs.filter(
    (pr) => pr.status === "ready" && pr.worktreeStatus === "ready" && pr.headSha,
  );
  if (ready.length === 0) {
    throw new ReviewWorkspaceError("no pull request in this workspace is checked out yet", 409);
  }
  if (ready.length > MAX_SESSION_PRS) {
    throw new ReviewWorkspaceError(
      `Ask Claude reads at most ${MAX_SESSION_PRS} pull requests; this workspace has ${ready.length}`,
      409,
    );
  }
  for (const pr of ready) assertWorktreeInWorkspace(config, pr);

  const cwd = freshSessionFolder(config, ws.id);
  // Real paths, as the sandbox compares them, so a linked workspaces folder
  // doesn't leave the write deny naming a path the sandbox never sees.
  const checkouts = ready.map((pr) => realpathSync(pr.worktreePath));
  // Paths and ref keys only: titles are the authors' text.
  const context = `The pull requests are checked out at: ${ready
    .map((pr, i) => `${pr.refKey} in ${checkouts[i]}`)
    .join("; ")}.`;
  try {
    await deps.spawn({
      workspaceId: ws.id,
      cwd,
      addDirs: checkouts,
      settings: JSON.stringify(reviewSessionSettings(cwd, checkouts)),
      context,
    });
  } catch (e) {
    // A spawn that timed out here may still land in the core, after a removal
    // queued behind this start has ended the session. Ending it while the lock
    // is held means nothing is left running.
    await deps.kill(ws.id).catch(() => {});
    // The core refuses for reasons the user can act on (the agent isn't Claude
    // Code, too many terminals open), so its message is the answer.
    throw new ReviewWorkspaceError(describeError(e), 502);
  }
  return { sessionId: reviewClaudeSessionId(ws.id) };
}
