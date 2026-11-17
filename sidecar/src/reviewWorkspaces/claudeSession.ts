/**
 * An interactive Claude Code session for a review workspace, for asking
 * questions about its PRs. One session covers every PR checked out in the
 * workspace, so it can answer across a stack. The user drives it in a tab; the
 * core owns the PTY.
 *
 * The user drives the session, so their own Claude Code config loads: their
 * settings, skills, plugins, hooks and MCP servers. The checkouts are code the
 * PRs' authors wrote, so the repos' own skills and CLAUDE.md load only when the
 * user ticks the workspace's option for it. Whatever loads, the session can't
 * edit files, since its job is answering questions, and Bash runs in the
 * review runs' sandbox: no network, no writes to the checkouts, and the home
 * folder's credentials unreadable. The core picks the setting sources and adds
 * a guardrail prompt when it builds the launch line
 * (`spawn_review_claude_session` in `src-tauri/src/pty.rs`).
 *
 * The launch line is typed into the user's login shell, whose hooks (mise,
 * direnv, a dotenv plugin) act on the folder it starts in and that folder's
 * parents. So the shell starts in a folder of Yarvis's own, emptied before
 * every start, and the checkouts reach the session as additional directories.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { lockedDownSettings } from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import {
  ControlTimeoutError,
  hasCoreChannel,
  killReviewClaudeSession,
  spawnReviewClaudeSession,
} from "../core/controlClient.ts";
import type { Db } from "../db/client.ts";
import { reviewWorkspaces } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import {
  assertWorktreeInWorkspace,
  getReviewWorkspace,
  ReviewWorkspaceError,
  refDomKey,
  reviewClonePath,
  reviewSessionFolder,
  reviewWorkspaceDir,
  withReviewWorkspaceLock,
} from "./service.ts";

/** The most checkouts one session reads; matches `MAX_REVIEW_DIRS` in `pty.rs`. */
const MAX_SESSION_PRS = 20;

/** The edit tools, which a session that answers questions never needs. */
const DENIED_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * The settings a review session runs with, on top of the user's own: the
 * review runs' denies and sandbox, minus edits. What only an unattended run
 * needs is left out (no hooks, no auto-memory, the built-in plugins off), so
 * the user's own hooks and plugins work. Sandboxed commands also can't write to any checkout, so
 * one PR's code can't change another's, which a later setup run would execute,
 * nor to the clones the checkouts share a `.git` with, whose hooks and config
 * the sidecar's own git commands would run, nor to the session's own folder,
 * which the next session's shell opens in, nor to the review workspace's
 * folder, where the core writes the session's settings and prompt.
 */
function reviewSessionSettings(
  sessionFolder: string,
  workspaceFolder: string,
  checkouts: string[],
  clones: string[],
): Record<string, unknown> {
  const {
    disableAllHooks: _hooks,
    autoMemoryEnabled: _memory,
    enabledPlugins: _plugins,
    ...settings
  } = lockedDownSettings();
  const permissions = settings.permissions as { deny: string[] };
  const sandbox = settings.sandbox as { filesystem: Record<string, unknown> };
  return {
    ...settings,
    permissions: { ...permissions, deny: [...permissions.deny, ...DENIED_TOOLS] },
    sandbox: {
      ...sandbox,
      filesystem: {
        ...sandbox.filesystem,
        denyWrite: [sessionFolder, workspaceFolder, ...checkouts, ...clones],
      },
    },
  };
}

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
    throw new ReviewWorkspaceError(
      `${dir} is a link or under one; remove it so Ask Claude can start`,
      409,
    );
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
 * Starts the workspace's session over every PR whose checkout is ready. If a
 * session is already running, the core keeps it and ignores this start; the
 * session folder is still emptied first, which is safe because a running
 * session can't write to it and reads its settings from elsewhere. A PR
 * checked out later joins on the next start. Runs under the workspace's lock,
 * so it can't start a session between a removal ending the old one and
 * deleting a checkout.
 */
export async function startReviewClaudeSession(
  db: Db,
  config: Config,
  workspaceId: string,
  deps: ReviewClaudeDeps = defaultReviewClaudeDeps,
  options: StartOptions = {},
): Promise<StartedSession> {
  if (!deps.hasCore()) {
    throw new ReviewWorkspaceError(
      "the app's core isn't running, so it can't start a session",
      503,
    );
  }
  return withReviewWorkspaceLock(workspaceId, () =>
    startLocked(db, config, workspaceId, deps, options),
  );
}

export interface StartOptions {
  /**
   * Saves whether the workspace's sessions load the repos' own skills and
   * CLAUDE.md. Left out, the saved choice is used. A running session keeps
   * the config it started with, so the caller ends it first to apply this.
   */
  loadRepoConfig?: boolean;
}

export interface StartedSession {
  /** Whether a session started now loads the repos' own config. */
  loadRepoConfig: boolean;
}

async function startLocked(
  db: Db,
  config: Config,
  workspaceId: string,
  deps: ReviewClaudeDeps,
  options: StartOptions,
): Promise<StartedSession> {
  const ws = await getReviewWorkspace(db, workspaceId);
  if (!ws) throw new ReviewWorkspaceError("review workspace not found", 404);
  if (ws.status !== "active") {
    throw new ReviewWorkspaceError(`review workspace is ${ws.status}`, 409);
  }
  const loadRepoConfig = options.loadRepoConfig ?? ws.askClaudeRepoConfig;
  if (loadRepoConfig !== ws.askClaudeRepoConfig) {
    await db
      .update(reviewWorkspaces)
      .set({ askClaudeRepoConfig: loadRepoConfig, updatedAt: new Date() })
      .where(eq(reviewWorkspaces.id, ws.id));
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
  const checkouts = ready.map((pr) => realFolder(pr.worktreePath));
  const clones = [...new Set(ready.map((pr) => realFolder(reviewClonePath(config, pr.ref))))];
  // Paths and sanitized ref keys only: titles are the authors' text, and an
  // Azure project or repo name is free text its owner chose.
  const context = `The pull requests are checked out at: ${ready
    .map((pr, i) => `${refDomKey(pr.ref)} in ${checkouts[i]}`)
    .join("; ")}.`;
  try {
    await deps.spawn({
      workspaceId: ws.id,
      cwd,
      addDirs: checkouts,
      settings: JSON.stringify(
        reviewSessionSettings(
          cwd,
          realFolder(reviewWorkspaceDir(config, ws.id)),
          checkouts,
          clones,
        ),
      ),
      context,
      loadRepoConfig,
    });
  } catch (e) {
    // A spawn that timed out may still land in the core, after a removal queued
    // behind this start has ended the session, so it's ended while the lock is
    // held. That also ends a session that was already running, which can't be
    // told apart from one that landed late.
    if (e instanceof ControlTimeoutError) await deps.kill(ws.id).catch(() => {});
    // The core refuses for reasons the user can act on (the agent isn't Claude
    // Code, too many terminals open), so its message is the answer.
    throw new ReviewWorkspaceError(describeError(e), 502);
  }
  return { loadRepoConfig };
}

/** A checkout or clone's real path; a 409 when it went missing after it was marked ready. */
function realFolder(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    throw new ReviewWorkspaceError(
      "a pull request's checkout is missing; refresh it and try again",
      409,
    );
  }
}
