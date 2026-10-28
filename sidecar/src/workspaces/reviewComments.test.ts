import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import type { GitRunner } from "./git.ts";
import { createReviewComment, listLocatedReviewComments } from "./reviewComments.ts";
import { archiveWorkspace, createWorkspace, getWorkspace, provisionWorkspace } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-review-root-"));

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
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
  if (args[0] === "ls-remote")
    return { stdout: "ref: refs/heads/main\tHEAD\n", stderr: "", exitCode: 0 };
  if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 };
  if (args[0] === "rev-parse") return { stdout: "cafebabe1234567\n", stderr: "", exitCode: 0 };
  if (args[0] === "worktree" && args[1] === "add") {
    const path = args[2] === "-b" ? args[4] : args[2];
    if (path) mkdirSync(path, { recursive: true });
  }
  return { stdout: "", stderr: "", exitCode: 0 };
};

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_review_comments, tasks, issue_links, events RESTART IDENTITY CASCADE`;
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
  source: string;
  resolvedAt: string | null;
}

/** Registers a repo; each needs its own name, since repos are unique per
 *  owner/name. */
async function addRepo(name: string): Promise<string> {
  const res = await app.request("/api/repos", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ cloneUrl: `git@github.com:acme/${name}.git` }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** A provisioned workspace, plus the ids of its worktree rows in the order the repos are named. */
async function workspaceWithRepos(
  name: string,
  repoNames: string[],
): Promise<{ id: string; repoIds: string[] }> {
  const repoIds = [];
  for (const repoName of repoNames) repoIds.push(await addRepo(repoName));
  const ws = await createWorkspace(db, config, { name, repoIds });
  await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
  const detail = await getWorkspace(db, ws.id);
  // Looked up by name: the rows are inserted together, so they share a
  // created_at and come back from getWorkspace in no fixed order.
  const idOf = new Map((detail?.repos ?? []).map((r) => [r.repo.name, r.id]));
  return { id: ws.id, repoIds: repoNames.map((repoName) => idOf.get(repoName) ?? "") };
}

/** The common case: one repo, and its worktree row id to file comments against. */
async function workspaceWithRepo(name = "review"): Promise<{ id: string; repoId: string }> {
  const ws = await workspaceWithRepos(name, [name]);
  return { id: ws.id, repoId: ws.repoIds[0] ?? "" };
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

  it("stores the source a request names, takes the user's by default, and refuses others", async () => {
    const ws = await workspaceWithRepo();
    const at = { workspaceRepoId: ws.repoId, path: "src/a.ts", startLine: 1, endLine: 1 };
    const finding = await post(ws.id, { ...at, body: "From the report", source: "verification" });
    expect(finding.status).toBe(201);
    const own = await post(ws.id, { ...at, body: "Mine" });
    expect((await post(ws.id, { ...at, body: "x", source: "bogus" })).status).toBe(400);
    expect(((await finding.json()) as Comment).source).toBe("verification");
    expect(((await own.json()) as Comment).source).toBe("user");
    // What the MCP tool reads, which fences by this field.
    const located = await listLocatedReviewComments(db, ws.id);
    expect(located.map((c) => [c.body, c.source])).toEqual([
      ["From the report", "verification"],
      ["Mine", "user"],
    ]);
  });

  it("keeps a report finding's body out of the event log", async () => {
    const ws = await workspaceWithRepo();
    const at = { workspaceRepoId: ws.repoId, path: "src/a.ts", startLine: 1, endLine: 1 };
    const finding = await createReviewComment(
      db,
      ws.id,
      { ...at, body: "Model-written finding", source: "verification" },
      fakeGit,
    );
    expect(finding?.source).toBe("verification");
    await createReviewComment(db, ws.id, { ...at, body: "My own note" }, fakeGit);

    const logged = async () =>
      (
        await sql<{ body: string }[]>`
          SELECT payload->>'body' AS body FROM events
          WHERE type = 'workspace.comment_added' AND payload->>'workspaceId' = ${ws.id}`
      ).map((r) => r.body);
    for (let i = 0; i < 50 && (await logged()).length === 0; i++) await Bun.sleep(10);
    expect(await logged()).toEqual(["My own note"]);
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

  // The list spans the workspace, not the repo the side panel happens to have
  // selected — a review is read as one list.
  it("lists comments from every repo in the workspace", async () => {
    const ws = await workspaceWithRepos("multi", ["web", "api"]);
    const base = { path: "src/a.ts", startLine: 1, endLine: 1 };
    await post(ws.id, { ...base, workspaceRepoId: ws.repoIds[0], body: "In the first repo." });
    await post(ws.id, { ...base, workspaceRepoId: ws.repoIds[1], body: "In the second repo." });

    const comments = await list(ws.id);
    expect(comments.map((c) => c.body)).toEqual(["In the first repo.", "In the second repo."]);
    expect(new Set(comments.map((c) => c.workspaceRepoId))).toEqual(new Set(ws.repoIds));
  });

  it("names each comment's repo and worktree for an agent working from the root", async () => {
    const mine = await workspaceWithRepos("located", ["web", "api"]);
    const theirs = await workspaceWithRepo("elsewhere");
    const base = { path: "src/a.ts", startLine: 1, endLine: 1 };
    await post(mine.id, { ...base, workspaceRepoId: mine.repoIds[0], body: "In web." });
    await post(mine.id, { ...base, workspaceRepoId: mine.repoIds[1], body: "In api." });
    await post(theirs.id, { ...base, workspaceRepoId: theirs.repoId, body: "Elsewhere." });

    const detail = await getWorkspace(db, mine.id);
    const worktreeOf = new Map<string, string>(
      (detail?.repos ?? []).map((r) => [r.id, r.worktreePath]),
    );
    const comments = await listLocatedReviewComments(db, mine.id);
    expect(comments.map((c) => [c.body, c.repoName, c.worktreePath])).toEqual([
      ["In web.", "web", worktreeOf.get(mine.repoIds[0] ?? "") ?? ""],
      ["In api.", "api", worktreeOf.get(mine.repoIds[1] ?? "") ?? ""],
    ]);
  });

  // The copied text numbers entries in list order, so the order is a contract.
  it("lists comments oldest first, in the order they were written", async () => {
    const ws = await workspaceWithRepo();
    const base = { workspaceRepoId: ws.repoId, path: "src/a.ts" };
    // Descending lines, so an accidental sort by anything but time shows up.
    await post(ws.id, { ...base, startLine: 30, endLine: 30, body: "First." });
    await post(ws.id, { ...base, startLine: 20, endLine: 20, body: "Second." });
    await post(ws.id, { ...base, startLine: 10, endLine: 10, body: "Third." });

    expect((await list(ws.id)).map((c) => c.body)).toEqual(["First.", "Second.", "Third."]);
  });

  it("answers with an empty list for a workspace that has no repos", async () => {
    const ws = await createWorkspace(db, config, { name: "scratch", repoIds: [] });
    const res = await app.request(`/api/workspaces/${ws.id}/review-comments`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // A malformed id reaches a uuid column, so without the check it would surface
  // as a Postgres type error — a 500 carrying driver detail.
  it("rejects a malformed workspace id as a bad request", async () => {
    const res = await app.request("/api/workspaces/not-a-uuid/review-comments", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed comment id as a bad request", async () => {
    const ws = await workspaceWithRepo();
    const res = await app.request(`/api/workspaces/${ws.id}/review-comments/not-a-uuid`, {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("refuses a path that points outside the worktree or forges a line", async () => {
    const ws = await workspaceWithRepo();
    for (const path of ["/etc/hosts", "../secrets.txt", "src/a.ts\n2. and also"]) {
      const res = await post(ws.id, {
        workspaceRepoId: ws.repoId,
        path,
        startLine: 1,
        endLine: 1,
        body: "Nope.",
      });
      expect(res.status).toBe(400);
    }
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

  // A partial archive stays reopenable — linked tasks aren't completed and the
  // workspace never reaches `archived` — so the review has to survive it too.
  it("keeps the comments when a worktree refuses to be removed", async () => {
    const ws = await workspaceWithRepo();
    await post(ws.id, {
      workspaceRepoId: ws.repoId,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      body: "Still needed — this archive did not finish.",
    });

    // The refused worktree stays listed, since git still has it registered.
    let refused = "";
    const dirtyGit: GitRunner = async (args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove" && !args.includes("--force")) {
        refused = args[2] ?? "";
        return { stdout: "", stderr: "worktree contains modified files", exitCode: 1 };
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return { stdout: `worktree ${refused}\0\0`, stderr: "", exitCode: 0 };
      }
      return fakeGit(args, opts);
    };

    const result = await archiveWorkspace(db, ws.id, {}, dirtyGit);
    expect(result.status).toBe("archiving");
    expect((await list(ws.id)).map((c) => c.body)).toEqual([
      "Still needed — this archive did not finish.",
    ]);
  });
});
