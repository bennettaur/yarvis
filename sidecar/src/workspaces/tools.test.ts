import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import type { IssueDetail, IssueSummary } from "../issues/types.ts";
import type { GitRunner } from "./git.ts";
import { createRepo } from "./service.ts";
import { buildWorkspaceTools, type WorkspaceGitHubClient } from "./tools.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

// Worktree creation does real mkdir under the workspaces root, so point it at a
// throwaway temp dir; all git commands themselves are mocked below.
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-ws-test-"));
const config = { workspacesRoot } as Config;

// The AI SDK passes a second options argument to execute; tests don't need it.
const opts = { toolCallId: "test", messages: [] } as never;

/** Mock git runner that makes provisioning succeed without touching a network. */
const okRunner: GitRunner = async (args) => {
  if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
  // No pre-existing branch, so provisioning keeps the intended branch name.
  if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
  return { stdout: "", stderr: "", exitCode: 0 };
};

/** Minimal IssueSummary for a repo's issue list, with sensible defaults. */
function issueSummary(number: number, title: string): IssueSummary {
  return {
    provider: "github",
    sourceKey: "acme/widget",
    sourceLabel: "acme/widget",
    externalId: String(number),
    displayId: `#${number}`,
    title,
    url: `https://github.com/acme/widget/issues/${number}`,
    state: "open",
    author: "octocat",
    assignees: [],
    labels: [{ name: "bug", color: null }],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    commentCount: 0,
  };
}

/**
 * Fake GitHub client for the issue-driven tools. Records the side-effect calls
 * so tests can assert assign/label happened without a token or network.
 */
function fakeGitHub(overrides: Partial<WorkspaceGitHubClient> = {}) {
  const calls = { assigned: [] as string[][], labeled: [] as string[][] };
  const client: WorkspaceGitHubClient = {
    viewer: async () => ({ login: "octocat" }),
    listRepoIssues: async () => [issueSummary(99, "Fix the widget")],
    issueDetail: async (_o, _r, number): Promise<IssueDetail> => ({
      ...issueSummary(number, "Fix the widget"),
      body: "The widget is broken.",
      comments: [],
    }),
    assignIssue: async (_o, _r, _n, assignees) => {
      calls.assigned.push(assignees);
    },
    ensureLabel: async () => {},
    addLabels: async (_o, _r, _n, labels) => {
      calls.labeled.push(labels);
    },
    ...overrides,
  };
  return { client, calls };
}

beforeEach(async () => {
  await sql`TRUNCATE workspaces, workspace_repos, workspace_repo_pr, repos, tasks, issue_links RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("workspace tools", () => {
  it("list_repos returns registered repos", async () => {
    await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, { gitRunner: okRunner });

    const result = (await tools.list_repos.execute!({}, opts)) as Array<{ name: string }>;

    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("widget");
  });

  it("create_workspace_session provisions and starts a session in the worktree", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    let startedCwd = "";
    let startedWorkspaceId = "";
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => {
        startedCwd = input.cwd;
        startedWorkspaceId = input.workspaceId;
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    const result = (await tools.create_workspace_session.execute!(
      { name: "Rename the API", repoIds: [repo.id] },
      opts,
    )) as { status?: string; sessionKey?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("active");
    expect(result.sessionKey).toBe(`ws-claude:${startedWorkspaceId}`);
    // Single-repo workspace launches inside the repo's worktree.
    expect(startedCwd).toContain("rename-the-api");
    expect(startedCwd).toContain("widget");
  });

  it("create_scratch_workspace_session provisions a repo-less workspace at its root", async () => {
    let startedCwd = "";
    let startedWorkspaceId = "";
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => {
        startedCwd = input.cwd;
        startedWorkspaceId = input.workspaceId;
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    const result = (await tools.create_scratch_workspace_session.execute!(
      { name: "Scratchpad" },
      opts,
    )) as { status?: string; sessionKey?: string; repos?: string[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("active");
    expect(result.repos).toEqual([]);
    expect(result.sessionKey).toBe(`ws-claude:${startedWorkspaceId}`);
    // No repo, so the session launches at the workspace root (the slug folder).
    expect(startedCwd).toContain("scratchpad");
    expect(startedCwd).not.toContain("widget");
  });

  it("does not start a session when provisioning fails", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    let started = false;
    const failRunner: GitRunner = async (args) => {
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
      if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
      if (args[0] === "worktree" && args[1] === "add") {
        return { stdout: "", stderr: "boom", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: failRunner,
      startClaudeSession: async () => {
        started = true;
        return { sessionKey: "ws-claude:unused" };
      },
    });

    const result = (await tools.create_workspace_session.execute!(
      { name: "Broken", repoIds: [repo.id] },
      opts,
    )) as { error?: string; status?: string };

    expect(result.error).toBeDefined();
    expect(result.status).toBe("error");
    expect(started).toBe(false);
  });

  it("start_workspace_session starts a session in an existing workspace", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const startedCwds: string[] = [];
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => {
        startedCwds.push(input.cwd);
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    // Create + provision an active workspace (this also starts a session once).
    const created = (await tools.create_workspace_session.execute!(
      { name: "Existing WS", repoIds: [repo.id] },
      opts,
    )) as { workspaceId?: string; status?: string };
    expect(created.status).toBe("active");
    const wsId = created.workspaceId as string;

    // Starting again on the existing workspace succeeds and reuses its worktree.
    const result = (await tools.start_workspace_session.execute!({ workspaceId: wsId }, opts)) as {
      error?: string;
      sessionKey?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.sessionKey).toBe(`ws-claude:${wsId}`);
    expect(startedCwds.length).toBe(2);
    expect(startedCwds[1]).toContain("existing-ws");
  });

  it("start_workspace_session errors on an unknown workspace", async () => {
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => ({ sessionKey: `ws-claude:${input.workspaceId}` }),
    });

    const result = (await tools.start_workspace_session.execute!(
      { workspaceId: "00000000-0000-0000-0000-000000000000" },
      opts,
    )) as { error?: string };

    expect(result.error).toBeDefined();
  });

  it("list_workspaces returns created workspaces", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => ({ sessionKey: `ws-claude:${input.workspaceId}` }),
    });
    await tools.create_workspace_session.execute!({ name: "WS One", repoIds: [repo.id] }, opts);

    const rows = (await tools.list_workspaces.execute!({}, opts)) as Array<{ name: string }>;
    expect(rows.some((w) => w.name === "WS One")).toBe(true);
  });

  it("list_repo_issues returns a repo's open issues", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const { client } = fakeGitHub();
    const tools = buildWorkspaceTools(db, config, { gitRunner: okRunner, githubClient: client });

    const result = (await tools.list_repo_issues.execute!({ repoId: repo.id }, opts)) as Array<{
      number: number;
      title: string;
    }>;

    expect(result.length).toBe(1);
    expect(result[0]!.number).toBe(99);
    expect(result[0]!.title).toBe("Fix the widget");
  });

  it("list_repo_issues errors without a github client", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, { gitRunner: okRunner, githubClient: null });

    const result = (await tools.list_repo_issues.execute!({ repoId: repo.id }, opts)) as {
      error?: string;
    };
    expect(result.error).toContain("GitHub token not configured");
  });

  it("start_work_on_issue provisions, links the issue, assigns, and starts a session", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const { client, calls } = fakeGitHub();
    let startedWorkspaceId = "";
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      githubClient: client,
      startClaudeSession: async (input) => {
        startedWorkspaceId = input.workspaceId;
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    const result = (await tools.start_work_on_issue.execute!(
      { repoId: repo.id, issueNumber: 99, assignSelf: true, applyLabel: true },
      opts,
    )) as {
      error?: string;
      status?: string;
      sessionKey?: string;
      workspaceId?: string;
      issue?: { number: number };
      warnings?: string[];
    };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("active");
    expect(result.sessionKey).toBe(`ws-claude:${startedWorkspaceId}`);
    expect(result.issue?.number).toBe(99);
    expect(result.warnings).toEqual([]);
    // GitHub side effects ran.
    expect(calls.assigned).toEqual([["octocat"]]);
    expect(calls.labeled).toEqual([["in progress"]]);
    // The issue was linked to the created workspace.
    const links = await db.select().from(schema.issueLinks);
    expect(links.length).toBe(1);
    expect(links[0]!.externalId).toBe("99");
    expect(links[0]!.workspaceId).toBe(result.workspaceId ?? null);
    expect(links[0]!.localStatus).toBe("in_progress");
  });

  it("get_workspace_status reports cached PR state for a workspace", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => ({ sessionKey: `ws-claude:${input.workspaceId}` }),
    });
    const created = (await tools.create_workspace_session.execute!(
      { name: "Status WS", repoIds: [repo.id] },
      opts,
    )) as { workspaceId: string };

    // Seed the poller's cache row the way pollOnce would.
    const [wr] = await db
      .select()
      .from(schema.workspaceRepos)
      .where(eq(schema.workspaceRepos.workspaceId, created.workspaceId));
    await db.insert(schema.workspaceRepoPr).values({
      workspaceRepoId: wr!.id,
      prNumber: 42,
      prUrl: "https://github.com/acme/widget/pull/42",
      prState: "open",
      isDraft: false,
      mergeable: "MERGEABLE",
      checkRollup: "success",
      checks: { total: 3, success: 3, failure: 0, pending: 0 },
      lastPolledAt: new Date(),
    });

    const result = (await tools.get_workspace_status.execute!(
      { workspaceId: created.workspaceId },
      opts,
    )) as { repos: Array<{ pr: { number: number; mergeable: string; checks: string } | null }> };

    expect(result.repos[0]!.pr?.number).toBe(42);
    expect(result.repos[0]!.pr?.mergeable).toBe("MERGEABLE");
    expect(result.repos[0]!.pr?.checks).toBe("success");
  });

  it("get_workspace_status marks an unpolled repo as not polled yet", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => ({ sessionKey: `ws-claude:${input.workspaceId}` }),
    });
    await tools.create_workspace_session.execute!({ name: "Fresh WS", repoIds: [repo.id] }, opts);

    const result = (await tools.get_workspace_status.execute!({}, opts)) as Array<{
      repos: Array<{ pr: unknown; note?: string }>;
    }>;

    expect(result.length).toBe(1);
    expect(result[0]!.repos[0]!.pr).toBeNull();
    expect(result[0]!.repos[0]!.note).toBe("not polled yet");
  });

  it("archive_workspace tears down a workspace", async () => {
    const repo = await createRepo(db, config, { cloneUrl: "https://github.com/acme/widget.git" });
    const tools = buildWorkspaceTools(db, config, {
      gitRunner: okRunner,
      startClaudeSession: async (input) => ({ sessionKey: `ws-claude:${input.workspaceId}` }),
    });
    const created = (await tools.create_workspace_session.execute!(
      { name: "Archive Me", repoIds: [repo.id] },
      opts,
    )) as { workspaceId: string };

    const result = (await tools.archive_workspace.execute!(
      { workspaceId: created.workspaceId, force: false },
      opts,
    )) as { status?: string; errors?: unknown[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("archived");
    expect(result.errors).toEqual([]);
  });
});
