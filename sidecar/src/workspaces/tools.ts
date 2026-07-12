import { tool } from "ai";
import { z } from "zod";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { GitHubClient } from "../github/client.ts";
import {
  applyStartWorkSideEffects,
  buildIssuePrompt,
  IN_PROGRESS_LABEL,
  type StartWorkSideEffectClient,
  sanitizeIssueText,
  upsertLink,
  writeIssuePrompt,
} from "../issues/service.ts";
import type { IssueDetail, IssueSummary } from "../issues/types.ts";
import {
  type ClaudeSessionStarter,
  startClaudeSession as defaultStartClaudeSession,
} from "./claudeSession.ts";
import { defaultGitRunner, type GitRunner } from "./git.ts";
import {
  archiveWorkspace,
  createWorkspace,
  getRepo,
  getWorkspace,
  listRepos,
  listWorkspaces,
  provisionWorkspace,
  type WorkspaceDetail,
} from "./service.ts";

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Shapes a workspace's cached PR + checks state (populated by the background
 * poller, so it needs no live GitHub call) into a compact per-repo summary the
 * chat model can answer "is there a PR / are checks passing / is it mergeable"
 * from. A repo with no cached row has not been polled yet.
 */
function summarizeWorkspaceStatus(detail: WorkspaceDetail) {
  return {
    id: detail.id,
    name: detail.name,
    status: detail.status,
    repos: detail.repos.map((wr) => {
      const pr = wr.pr;
      if (!pr || pr.prNumber === null) {
        return {
          repo: wr.repo.name,
          branch: wr.branch,
          pr: null,
          note: pr ? "no PR opened yet" : "not polled yet",
        };
      }
      return {
        repo: wr.repo.name,
        branch: wr.branch,
        pr: {
          number: pr.prNumber,
          url: pr.prUrl,
          state: pr.prState,
          isDraft: pr.isDraft,
          mergeable: pr.mergeable,
          checks: pr.checkRollup,
          checkCounts: pr.checks,
          lastPolledAt: pr.lastPolledAt,
          lastError: pr.lastError,
        },
      };
    }),
  };
}

/**
 * The slice of the GitHub client the issue-driven tools need: listing a repo's
 * issues, loading one issue's body for the seed prompt, plus the "start work"
 * side effects (assign + label). Narrowed to an interface so tests can inject a
 * fake without a token or network.
 */
export interface WorkspaceGitHubClient extends StartWorkSideEffectClient {
  listRepoIssues(
    owner: string,
    repo: string,
    opts?: { assignee?: string; state?: string },
  ): Promise<IssueSummary[]>;
  issueDetail(owner: string, repo: string, number: number): Promise<IssueDetail>;
}

/** Injectable collaborators, overridden in tests to avoid real git/claude/github. */
export interface WorkspaceToolDeps {
  startClaudeSession?: ClaudeSessionStarter;
  gitRunner?: GitRunner;
  /** Overrides the GitHub client the issue tools use; defaults to a client built
   *  from the configured token (null when no token is set). */
  githubClient?: WorkspaceGitHubClient | null;
}

/**
 * Workspace tools for the chat agent. Read-only lookups (repos, a repo's open
 * issues, workspace list, workspace PR/check status) plus fixed-purpose actions:
 * create a workspace (from repos, from an issue like the issue-view "Start
 * work", or scratch) and start a remote-controllable Claude Code session in it,
 * and archive a workspace. Deliberately no general shell access.
 */
export function buildWorkspaceTools(db: Db, config: Config, deps: WorkspaceToolDeps = {}) {
  const startClaude = deps.startClaudeSession ?? defaultStartClaudeSession;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  // `undefined` means "not overridden" → fall back to a token-backed client;
  // an explicit `null` (or a missing token) means "no GitHub access".
  const github: WorkspaceGitHubClient | null =
    deps.githubClient !== undefined
      ? deps.githubClient
      : config.secrets?.githubToken
        ? new GitHubClient(config.secrets.githubToken)
        : null;

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
      const session = await startClaude({ workspaceId: detail.id, cwd, name: detail.name });
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
        error: errorMessage(e),
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

    list_repo_issues: tool({
      description:
        "List open issues for a registered repo so the user can pick tickets to start work on. Resolve the repo id with list_repos first. Returns each issue's number, title, url, author, assignees, and labels. Requires a configured GitHub token.",
      inputSchema: z.object({
        repoId: z.string().uuid().describe("Id of a registered repo, from list_repos"),
        assignedToMe: z
          .boolean()
          .optional()
          .describe("Only issues assigned to the authenticated user"),
      }),
      execute: async ({ repoId, assignedToMe }) => {
        if (!github) return { error: "GitHub token not configured; cannot list issues" };
        const repo = await getRepo(db, repoId);
        if (!repo) return { error: "repo not found; call list_repos to get a valid id" };
        try {
          const assignee = assignedToMe ? (await github.viewer()).login : undefined;
          const issues = await github.listRepoIssues(repo.owner, repo.repo, { assignee });
          // Issue titles are third-party-authored free text flowing into the chat
          // model's context; strip the hidden/bidi/comment characters that could
          // smuggle instructions the user wouldn't see on the rendered issue.
          return issues.map((i) => ({
            number: Number(i.externalId),
            title: sanitizeIssueText(i.title),
            url: i.url,
            author: i.author,
            assignees: i.assignees,
            labels: i.labels.map((l) => l.name),
          }));
        } catch (e) {
          return { error: errorMessage(e) };
        }
      },
    }),

    start_work_on_issue: tool({
      description:
        "Start work on a repo issue exactly like the 'Start work' button on the issue view: create a workspace with a worktree cut from the repo's default branch, provision it, seed the issue details into .yarvis/issue-prompt.md, assign the issue to the user and label it in-progress on GitHub (best-effort), and start a remote-controllable Claude Code session in it. Resolve the repo id with list_repos and pick an issue number with list_repo_issues first. Requires a configured GitHub token.",
      inputSchema: z.object({
        repoId: z.string().uuid().describe("Id of the registered repo the issue belongs to"),
        issueNumber: z.number().int().positive().describe("The issue number, e.g. 99"),
        assignSelf: z
          .boolean()
          .default(true)
          .describe("Assign the issue to the authenticated user on GitHub"),
        applyLabel: z
          .boolean()
          .default(true)
          .describe("Add the in-progress label to the issue on GitHub"),
      }),
      execute: async ({ repoId, issueNumber, assignSelf, applyLabel }) => {
        if (!github) return { error: "GitHub token not configured; cannot start work on an issue" };
        const repo = await getRepo(db, repoId);
        if (!repo) return { error: "repo not found; call list_repos to get a valid id" };

        let issue: IssueDetail;
        try {
          issue = await github.issueDetail(repo.owner, repo.repo, issueNumber);
        } catch (e) {
          return { error: `could not load issue #${issueNumber}: ${errorMessage(e)}` };
        }

        const ws = await createWorkspace(db, config, { name: issue.title, repoIds: [repo.id] });
        await provisionWorkspace(db, ws.id, () => undefined, gitRunner);

        const detail = await getWorkspace(db, ws.id);
        if (!detail) return { error: "workspace vanished after creation" };
        if (detail.status !== "active") {
          const failures = detail.repos
            .filter((r) => r.status === "error")
            .map((r) => ({ repo: r.repo.name, message: r.error ?? "unknown error" }));
          return {
            error: "workspace provisioning failed; work not started",
            workspaceId: ws.id,
            status: detail.status,
            failures,
          };
        }

        const sourceKey = `${repo.owner}/${repo.repo}`;
        await upsertLink(db, {
          provider: "github",
          sourceKey,
          externalId: String(issueNumber),
          title: issue.title,
          url: issue.url,
          workspaceId: ws.id,
          localStatus: "in_progress",
        });

        // Best-effort GitHub side effects; a read-only token degrades to warnings.
        const warnings = await applyStartWorkSideEffects(
          github,
          repo.owner,
          repo.repo,
          issueNumber,
          {
            assignSelf,
            applyLabel,
            label: IN_PROGRESS_LABEL,
          },
        );

        // Seed the same prompt file the issue view writes, so the session (driven
        // from claude.ai/code or the Claude app) can read and implement the ticket.
        const prompt = buildIssuePrompt({
          displayId: `#${issueNumber}`,
          title: issue.title,
          url: issue.url,
          body: issue.body,
          sourceKey,
        });
        try {
          await writeIssuePrompt(detail.rootPath, prompt);
        } catch (e) {
          warnings.push(`could not write issue prompt: ${errorMessage(e)}`);
        }

        const launch = await launchClaude(detail);
        return {
          ...launch,
          issue: { number: issueNumber, title: issue.title, url: issue.url },
          warnings,
          promptFile: ".yarvis/issue-prompt.md",
          nextStep:
            "In the session, tell Claude to read .yarvis/issue-prompt.md and implement the ticket.",
        };
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

    create_scratch_workspace_session: tool({
      description:
        "Create a scratch workspace — just a folder, no repo or git worktree — provision it, and start a remote-controllable Claude Code session in it. Use this for experimentation and exploration when the user doesn't need a specific repo checked out. The session is drivable from claude.ai/code or the Claude mobile app by its name and appears as a live terminal in the Workspaces tab.",
      inputSchema: z.object({
        name: z.string().describe("Human-readable workspace name, e.g. 'Scratchpad'"),
        taskId: z
          .string()
          .uuid()
          .optional()
          .describe("Optional task to link; archiving the workspace completes it"),
      }),
      execute: async ({ name, taskId }) => {
        const ws = await createWorkspace(db, config, { name, repoIds: [], taskId });
        await provisionWorkspace(db, ws.id, () => undefined, gitRunner);

        const detail = await getWorkspace(db, ws.id);
        if (!detail) return { error: "workspace vanished after creation" };
        if (detail.status !== "active") {
          return {
            error: "workspace provisioning failed; Claude session not started",
            workspaceId: ws.id,
            status: detail.status,
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

    get_workspace_status: tool({
      description:
        "Report the pull-request and CI-check state of workspaces so you can answer whether a PR exists, whether its checks are passing, and whether it is mergeable. Pass a workspaceId (from list_workspaces) for one workspace, or omit it to report every non-archived workspace. Reads cached state refreshed by the background poller, not a live GitHub call, so a just-created workspace may not be polled yet.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .uuid()
          .optional()
          .describe("Id of a specific workspace; omit to report all non-archived workspaces"),
      }),
      execute: async ({ workspaceId }) => {
        if (workspaceId) {
          const detail = await getWorkspace(db, workspaceId);
          if (!detail) return { error: "workspace not found" };
          return summarizeWorkspaceStatus(detail);
        }
        const rows = await listWorkspaces(db);
        const active = rows.filter((w) => w.status !== "archived");
        const details = await Promise.all(active.map((w) => getWorkspace(db, w.id)));
        return details
          .filter((d): d is WorkspaceDetail => d !== null)
          .map(summarizeWorkspaceStatus);
      },
    }),

    archive_workspace: tool({
      description:
        "Archive a workspace: stop its Claude session, tear down its git worktrees, and mark it archived (completing any linked task). Resolve the workspace id with list_workspaces first. If a worktree has uncommitted changes the archive is refused and stays in 'archiving'; retry with force=true to discard that work. Report back the returned status and any errors.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .uuid()
          .describe("Id of the workspace to archive, from list_workspaces"),
        summary: z.string().optional().describe("Optional note recorded on the archived workspace"),
        force: z
          .boolean()
          .default(false)
          .describe("Discard uncommitted changes in the worktrees so teardown can proceed"),
      }),
      execute: async ({ workspaceId, summary, force }) => {
        try {
          const result = await archiveWorkspace(
            db,
            workspaceId,
            { summary: summary ?? null, force },
            gitRunner,
          );
          return {
            workspaceId,
            status: result.status,
            errors: result.errors,
            completedTasks: result.completedTasks,
            note:
              result.status === "archived"
                ? "Workspace archived."
                : "Archive incomplete; some worktrees could not be removed (often uncommitted changes). Retry with force=true to discard them.",
          };
        } catch (e) {
          return { error: errorMessage(e) };
        }
      },
    }),
  };
}
