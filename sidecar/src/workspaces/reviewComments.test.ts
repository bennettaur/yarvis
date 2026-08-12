import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import type { GitRunner } from "./git.ts";
import { createReviewComment } from "./reviewComments.ts";
import { archiveWorkspace, createWorkspace, getWorkspace, provisionWorkspace } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-review-root-"));

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot,
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const db = getDb(url).db;
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

/** A no-op git runner that answers the reads this feature makes. */
const fakeGit: GitRunner = async (args) => {
  if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
  if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
  if (args[0] === "rev-parse") return { stdout: "cafebabe1234567\n", stderr: "", exitCode: 0 };
  if (args[0] === "worktree" && args[1] === "add") {
    const path = args[2] === "-b" ? args[4] : args[2];
    if (path) mkdirSync(path, { recursive: true });
  }
  return { stdout: "", stderr: "", exitCode: 0 };
};

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_review_comments, tasks, issue_links RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
  rmSync(workspacesRoot, { recursive: true, force: true });
});

interface Comment {
  id: string;
  workspaceRepoId: string;
  path: string;
  startLine: number;
  endLine: number;
  commitSha: string | null;
  body: string;
  resolvedAt: string | null;
}

/** A provisioned single-repo workspace, plus the id of its worktree row. Each
 *  gets its own repo, since repos are unique per owner/name. */
async function workspaceWithRepo(name = "review"): Promise<{ id: string; repoId: string }> {
  const repoRes = await app.request("/api/repos", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ cloneUrl: `git@github.com:acme/${name}.git` }),
  });
  const repo = (await repoRes.json()) as { id: string };
  const ws = await createWorkspace(db, config, { name, repoIds: [repo.id] });
  await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
  const detail = await getWorkspace(db, ws.id);
  return { id: ws.id, repoId: detail?.repos[0]?.id ?? "" };
}

const post = (workspaceId: string, body: unknown) =>
  app.request(`/api/workspaces/${workspaceId}/review-comments`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });

const list = async (workspaceId: string): Promise<Comment[]> => {
  const res = await app.request(`/api/workspaces/${workspaceId}/review-comments`, {
    headers: auth,
  });
  return (await res.json()) as Comment[];
};

describe("review comment routes", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/workspaces/any/review-comments");
    expect(res.status).toBe(401);
  });

  it("records a comment against the file and its line range", async () => {
    const ws = await workspaceWithRepo();
    const res = await post(ws.id, {
      workspaceRepoId: ws.repoId,
      path: "src/a.ts",
      startLine: 12,
      endLine: 18,
      body: "Fold these together.",
    });
    expect(res.status).toBe(201);
    const comment = (await res.json()) as Comment;
    expect(comment.path).toBe("src/a.ts");
    expect(comment.startLine).toBe(12);
    expect(comment.endLine).toBe(18);
    expect(comment.resolvedAt).toBeNull();
  });

  // Through the service rather than the route: the sha comes from the real git
  // runner the route uses, and the test worktrees are empty directories.
  it("stamps the comment with the worktree's HEAD", async () => {
    const ws = await workspaceWithRepo();
    const comment = await createReviewComment(
      db,
      ws.id,
      {
        workspaceRepoId: ws.repoId,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        body: "Which commit was this?",
      },
      fakeGit,
    );
    expect(comment?.commitSha).toBe("cafebabe1234567");
  });

  it("records a comment even when the branch has no commits to name", async () => {
    const ws = await workspaceWithRepo();
    const noHead: GitRunner = async (args, opts) =>
      args[0] === "rev-parse" ? { stdout: "", stderr: "", exitCode: 128 } : fakeGit(args, opts);
    const comment = await createReviewComment(
      db,
      ws.id,
      {
        workspaceRepoId: ws.repoId,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        body: "Written before the first commit.",
      },
      noHead,
    );
    expect(comment?.commitSha).toBeNull();
    expect(comment?.body).toBe("Written before the first commit.");
  });

  it("rejects a range that runs backwards", async () => {
    const ws = await workspaceWithRepo();
    const res = await post(ws.id, {
      workspaceRepoId: ws.repoId,
      path: "src/a.ts",
      startLine: 18,
      endLine: 12,
      body: "Backwards.",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a repo that belongs to another workspace", async () => {
    const mine = await workspaceWithRepo("mine");
    const theirs = await workspaceWithRepo("theirs");
    const res = await post(mine.id, {
      workspaceRepoId: theirs.repoId,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      body: "Not mine to comment on.",
    });
    expect(res.status).toBe(404);
  });

  it("lists a workspace's comments and nobody else's", async () => {
    const mine = await workspaceWithRepo("mine");
    const theirs = await workspaceWithRepo("theirs");
    const base = { path: "src/a.ts", startLine: 1, endLine: 1 };
    await post(mine.id, { ...base, workspaceRepoId: mine.repoId, body: "Mine." });
    await post(theirs.id, { ...base, workspaceRepoId: theirs.repoId, body: "Theirs." });

    expect((await list(mine.id)).map((c) => c.body)).toEqual(["Mine."]);
    expect((await list(theirs.id)).map((c) => c.body)).toEqual(["Theirs."]);
  });

  it("resolves and reopens a comment", async () => {
    const ws = await workspaceWithRepo();
    const created = (await (
      await post(ws.id, {
        workspaceRepoId: ws.repoId,
        path: "src/a.ts",
        startLine: 3,
        endLine: 3,
        body: "Rename this.",
      })
    ).json()) as Comment;

    const patch = (resolved: boolean) =>
      app.request(`/api/workspaces/${ws.id}/review-comments/${created.id}`, {
        method: "PATCH",
        headers: jsonAuth,
        body: JSON.stringify({ resolved }),
      });

    expect(((await (await patch(true)).json()) as Comment).resolvedAt).not.toBeNull();
    expect(((await (await patch(false)).json()) as Comment).resolvedAt).toBeNull();
  });

  it("refuses to update a comment in another workspace", async () => {
    const mine = await workspaceWithRepo("mine");
    const theirs = await workspaceWithRepo("theirs");
    const created = (await (
      await post(theirs.id, {
        workspaceRepoId: theirs.repoId,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        body: "Theirs.",
      })
    ).json()) as Comment;

    const res = await app.request(`/api/workspaces/${mine.id}/review-comments/${created.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ resolved: true }),
    });
    expect(res.status).toBe(404);
    expect((await list(theirs.id))[0]?.resolvedAt).toBeNull();
  });

  it("deletes a comment", async () => {
    const ws = await workspaceWithRepo();
    const created = (await (
      await post(ws.id, {
        workspaceRepoId: ws.repoId,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        body: "Drop this.",
      })
    ).json()) as Comment;

    const res = await app.request(`/api/workspaces/${ws.id}/review-comments/${created.id}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await list(ws.id)).toEqual([]);
  });

  it("drops every comment when the workspace is archived", async () => {
    const ws = await workspaceWithRepo();
    await post(ws.id, {
      workspaceRepoId: ws.repoId,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      body: "Only useful until this lands.",
    });

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.status).toBe("archived");
    expect(await list(ws.id)).toEqual([]);
  });
});
