import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { CLAUDE_COMMAND_KEY, getSetting } from "../settings/service.ts";
import {
  type ClaudeSessionStarter,
  startClaudeSession as defaultStartClaudeSession,
} from "./claudeSession.ts";
import { defaultGitRunner, type GitRunner } from "./git.ts";
import {
  createWorkspace,
  getWorkspace,
  listRepos,
  listWorkspaces,
  provisionWorkspace,
  type WorkspaceDetail,
} from "./service.ts";

/** Injectable collaborators, overridden in tests to avoid real git/claude. */
export interface WorkspaceToolDeps {
  startClaudeSession?: ClaudeSessionStarter;
  gitRunner?: GitRunner;
}

/**
 * Workspace tools for the chat agent: a read-only repo lookup plus the single
 * action that creates a workspace, provisions its worktrees, and starts a
 * remote-controllable Claude Code session in it. Deliberately no general shell
 * access — just this one fixed-purpose action.
 */
export function buildWorkspaceTools(db: Db, config: Config, deps: WorkspaceToolDeps = {}) {
  const startClaude = deps.startClaudeSession ?? defaultStartClaudeSession;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;

  /**
   * Starts a Claude session in an already-active workspace and shapes the tool
   * result. Shared by create_workspace_session (after provisioning) and
   * start_workspace_session (existing workspace). One repo → its worktree;
   * multiple → the workspace root so Claude sees each worktree as a subfolder.
   */
  const launchClaude = async (detail: WorkspaceDetail) => {
    const [firstRepo] = detail.repos;
    const cwd = detail.repos.length === 1 && firstRepo ? firstRepo.worktreePath : detail.rootPath;
    try {
      const baseCommand = (await getSetting(db, CLAUDE_COMMAND_KEY)) ?? config.claudeCommand;
      const session = await startClaude({
        workspaceId: detail.id,
        cwd,
        name: detail.name,
        baseCommand,
      });
      return {
        workspaceId: detail.id,
        name: detail.name,
        status: detail.status,
        repos: detail.repos.map((r) => r.repo.name),
        sessionName: detail.name,
        sessionKey: session.sessionKey,
        message: `Started a remote-controllable Claude Code session in workspace "${detail.name}". Open it from claude.ai/code or the Claude mobile app by the name "${detail.name}", or view it live in the Workspaces tab.`,
      };
    } catch (e) {
      // The workspace is ready; only the Claude launch failed (commonly: not
      // logged in). Surface that without discarding the usable workspace.
      return {
        error: e instanceof Error ? e.message : String(e),
        workspaceId: detail.id,
        name: detail.name,
        status: detail.status,
        note: "Workspace is ready; the Claude session failed to start. You can open the workspace locally and start Claude there.",
      };
    }
  };

  return {
    list_repos: tool({
      description:
        "List the repositories registered in Yarvis that can be used to build a workspace. Call this to resolve a repo the user names (e.g. 'yarvis') to its id before calling create_workspace_session.",
      inputSchema: z.object({}),
      execute: async () => {
        const repos = await listRepos(db);
        return repos.map((r) => ({ id: r.id, name: r.name, owner: r.owner, repo: r.repo }));
      },
    }),

    create_workspace_session: tool({
      description:
        "Create a new workspace from one or more registered repos (a git worktree per repo, cut from the default branch), provision it, and start a remote-controllable Claude Code session in it. The session can be driven from claude.ai/code or the Claude mobile app by its name, and shows up as a live terminal in the workspace's Workspaces tab to continue locally. Resolve repo ids with list_repos first.",
      inputSchema: z.object({
        name: z.string().describe("Human-readable workspace name, e.g. 'Rename the API'"),
        repoIds: z
          .array(z.string().uuid())
          .min(1)
          .describe("Ids of registered repos to include, from list_repos"),
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional task to link; archiving the workspace completes it"),
      }),
      execute: async ({ name, repoIds, taskId }) => {
        const ws = await createWorkspace(db, config, { name, repoIds, taskId });
        // Provisioning streams progress over SSE in the route; here we just drive
        // it to completion and inspect the resulting status.
        await provisionWorkspace(db, ws.id, () => undefined, gitRunner);

        const detail = await getWorkspace(db, ws.id);
        if (!detail) return { error: "workspace vanished after creation" };
        if (detail.status !== "active") {
          const failures = detail.repos
            .filter((r) => r.status === "error")
            .map((r) => ({ repo: r.repo.name, message: r.error ?? "unknown error" }));
          return {
            error: "workspace provisioning failed; Claude session not started",
            workspaceId: ws.id,
            status: detail.status,
            failures,
          };
        }

        return launchClaude(detail);
      },
    }),

    list_workspaces: tool({
      description:
        "List existing workspaces (id, name, status, repos) so you can act on one — e.g. start a Claude session in it with start_workspace_session.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await listWorkspaces(db);
        return rows.map((w) => ({
          id: w.id,
          name: w.name,
          status: w.status,
          repos: w.repoNames,
        }));
      },
    }),

    start_workspace_session: tool({
      description:
        "Start a remote-controllable Claude Code session in an existing, already-provisioned workspace. Resolve the workspace id with list_workspaces first. The session is drivable from claude.ai/code or the Claude mobile app and appears as a live terminal tab in the Workspaces tab.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .uuid()
          .describe("Id of an existing workspace, from list_workspaces"),
      }),
      execute: async ({ workspaceId }) => {
        const detail = await getWorkspace(db, workspaceId);
        if (!detail) return { error: "workspace not found" };
        if (detail.status !== "active") {
          return {
            error: `workspace is not ready to start a session (status: ${detail.status})`,
            workspaceId,
            status: detail.status,
          };
        }
        return launchClaude(detail);
      },
    }),
  };
}
