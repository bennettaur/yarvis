import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import type { GitRunner } from "./git.ts";
import { createRepo } from "./service.ts";
import { buildWorkspaceTools } from "./tools.ts";

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

beforeEach(async () => {
  await sql`TRUNCATE workspaces, workspace_repos, workspace_repo_pr, repos, tasks RESTART IDENTITY CASCADE`;
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
});
