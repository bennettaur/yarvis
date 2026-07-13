import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { tasks, workspaceRepoPr, workspaceRepos } from "../db/schema.ts";
import type { GitRunner } from "./git.ts";
import {
  archiveWorkspace,
  assertSafeBranchName,
  createWorkspace,
  getWorkspace,
  listRepoBranches,
  provisionWorkspace,
  unlinkTask,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-ws-root-"));

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot,
  secrets: {},
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const db = getDb(url).db;
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

/** A no-op git runner; symbolic-ref answers so default-branch detection works. */
const fakeGit: GitRunner = async (args) => {
  if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
  if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 1 }; // branch absent
  // Create the worktree dir like real git would, so setup scripts have a cwd.
  // New branch: "worktree add -b <branch> <path> <base>" (path is args[4]).
  // Existing branch: "worktree add <path> <branch>" (path is args[2]).
  if (args[0] === "worktree" && args[1] === "add") {
    const path = args[2] === "-b" ? args[4] : args[2];
    if (path) mkdirSync(path, { recursive: true });
  }
  return { stdout: "", stderr: "", exitCode: 0 };
};

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr, tasks RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
  rmSync(workspacesRoot, { recursive: true, force: true });
});

async function addRepo(cloneUrl = "git@github.com:acme/widget.git"): Promise<{ id: string }> {
  const res = await app.request("/api/repos", {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({ cloneUrl }),
  });
  return (await res.json()) as { id: string };
}

describe("assertSafeBranchName", () => {
  it("accepts ordinary branch names", () => {
    for (const name of ["main", "feat/login", "release-2.1", "fix_bug"]) {
      expect(() => assertSafeBranchName(name)).not.toThrow();
    }
  });

  it("rejects a leading dash so git can't read it as a flag", () => {
    expect(() => assertSafeBranchName("--upload-pack=x")).toThrow("unsupported branch name");
  });

  it("rejects whitespace and git-forbidden characters", () => {
    for (const name of ["", "a b", "a~1", "a^", "a:b", "a?b", "a*b", "a[b", "a\\b"]) {
      expect(() => assertSafeBranchName(name)).toThrow("unsupported branch name");
    }
  });
});

describe("repo routes", () => {
  it("requires authentication", async () => {
    const res = await app.request("/api/repos");
    expect(res.status).toBe(401);
  });

  it("creates a repo, deriving owner/repo and name from the clone URL", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "git@github.com:acme/widget.git" }),
    });
    expect(res.status).toBe(201);
    const repo = (await res.json()) as { owner: string; repo: string; name: string };
    expect(repo.owner).toBe("acme");
    expect(repo.repo).toBe("widget");
    expect(repo.name).toBe("widget");
  });

  it("rejects an unparseable clone URL", async () => {
    const res = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "not-a-url" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses to delete a repo still used by a workspace", async () => {
    const repo = await addRepo();
    await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "task", repoIds: [repo.id] }),
    });
    const res = await app.request(`/api/repos/${repo.id}`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(409);
  });
});

describe("workspace routes", () => {
  it("creates a workspace with a repo row and creating status", async () => {
    const repo = await addRepo();
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "Rename the API", repoIds: [repo.id] }),
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string; slug: string; status: string };
    expect(ws.slug).toBe("rename-the-api");
    expect(ws.status).toBe("creating");

    const detail = await app.request(`/api/workspaces/${ws.id}`, { headers: auth });
    const body = (await detail.json()) as { repos: unknown[] };
    expect(body.repos.length).toBe(1);
  });

  it("lists workspaces with their repo names for grouping", async () => {
    const repo = await addRepo();
    await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "grouped", repoIds: [repo.id] }),
    });
    const res = await app.request("/api/workspaces", { headers: auth });
    const list = (await res.json()) as { name: string; repoNames: string[] }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.repoNames).toEqual(["widget"]);
  });

  it("finds the workspace a cached PR was raised from, case-insensitively", async () => {
    const repo = await addRepo();
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "pr backlink", repoIds: [repo.id] }),
    });
    const ws = (await created.json()) as { id: string; name: string };
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber: 42 });

    const res = await app.request("/api/workspaces/for-pr?owner=ACME&repo=Widget&number=42", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const found = (await res.json()) as { id: string; name: string } | null;
    expect(found?.id).toBe(ws.id);
    expect(found?.name).toBe("pr backlink");
  });

  it("returns null when no workspace matches the PR", async () => {
    const res = await app.request("/api/workspaces/for-pr?owner=acme&repo=widget&number=999", {
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("finds the workspace an Azure PR was raised from, matched on the clone URL", async () => {
    const repo = await addRepo("https://dev.azure.com/acme/Shop/_git/web");
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "azure backlink", repoIds: [repo.id] }),
    });
    const ws = (await created.json()) as { id: string };
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber: 55 });

    const res = await app.request(
      "/api/workspaces/for-pr?provider=azure&org=acme&project=Shop&repo=web&number=55",
      { headers: auth },
    );
    expect(res.status).toBe(200);
    const found = (await res.json()) as { id: string } | null;
    expect(found?.id).toBe(ws.id);
  });

  it("returns 404 for files of an unknown workspace repo", async () => {
    const res = await app.request(
      "/api/workspaces/x/repos/00000000-0000-0000-0000-000000000000/files",
      { headers: auth },
    );
    expect(res.status).toBe(404);
  });

  it("creates a scratch workspace with no repos", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "scratch", repoIds: [] }),
    });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as { id: string; status: string };
    expect(ws.status).toBe("creating");

    const detail = await app.request(`/api/workspaces/${ws.id}`, { headers: auth });
    const body = (await detail.json()) as { repos: unknown[] };
    expect(body.repos.length).toBe(0);
  });

  it("creates a scratch workspace when repoIds is omitted", async () => {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "scratch-default" }),
    });
    expect(res.status).toBe(201);
  });
});

describe("provision + archive (injected git runner)", () => {
  it("provisions every repo to ready and marks the workspace active", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "feature", repoIds: [repo.id] });

    const events: string[] = [];
    await provisionWorkspace(db, ws.id, (e) => void events.push(e.type), fakeGit);

    expect(events).toContain("done");
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    expect(detail?.repos[0]?.status).toBe("ready");
  });

  it("checks out an existing branch when one is chosen, without cutting a new one", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "on-existing",
      repoIds: [repo.id],
      existingBranches: { [repo.id]: "feat/login" },
    });

    const worktreeAdds: string[][] = [];
    const trackingGit: GitRunner = async (args) => {
      if (args[0] === "worktree" && args[1] === "add") worktreeAdds.push(args);
      return fakeGit(args, {});
    };
    await provisionWorkspace(db, ws.id, () => {}, trackingGit);

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    const wr = detail?.repos[0];
    expect(wr?.branch).toBe("feat/login");
    expect(wr?.existingBranch).toBe(true);
    // Adds the worktree on the bare branch name — never with -b (no new branch).
    expect(worktreeAdds).toEqual([["worktree", "add", wr!.worktreePath, "feat/login"]]);
  });

  it("fetches the existing branch before adding its worktree and keeps the diff base", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "fetch-order",
      repoIds: [repo.id],
      existingBranches: { [repo.id]: "feat/login" },
    });

    const order: string[] = [];
    const orderingGit: GitRunner = async (args) => {
      if (args[0] === "fetch" && args[2] === "feat/login") order.push("fetch");
      if (args[0] === "worktree" && args[1] === "add") order.push("worktree-add");
      return fakeGit(args, {});
    };
    await provisionWorkspace(db, ws.id, () => {}, orderingGit);

    // DWIM tracking depends on origin/feat/login existing before the add.
    expect(order).toEqual(["fetch", "worktree-add"]);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.repos[0]?.baseBranch).toBe("main");
  });

  it("mixes an existing-branch repo with a new-branch repo in one workspace", async () => {
    const db = getDb(url).db;
    const r1 = await addRepo("git@github.com:acme/widget.git");
    const r2 = await addRepo("git@github.com:acme/gadget.git");
    const ws = await createWorkspace(db, config, {
      name: "mixed",
      repoIds: [r1.id, r2.id],
      // Only the first repo gets an existing branch; the second falls back.
      existingBranches: { [r1.id]: "feat/login", [r2.id]: "" },
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const detail = await getWorkspace(db, ws.id);
    const byRepo = new Map(detail?.repos.map((wr) => [wr.repoId, wr]));
    expect(byRepo.get(r1.id)?.existingBranch).toBe(true);
    expect(byRepo.get(r1.id)?.branch).toBe("feat/login");
    expect(byRepo.get(r2.id)?.existingBranch).toBe(false);
    expect(byRepo.get(r2.id)?.branch).toBe("yarvis/mixed");
  });

  it("lists the repo's remote branches, stripping origin/ and origin/HEAD", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const branchGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") {
        return { stdout: "origin/HEAD\norigin/main\norigin/feat/login\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    expect(await listRepoBranches(db, repo.id, branchGit)).toEqual(["main", "feat/login"]);
  });

  it("throws 'repo not found' listing branches for an unknown repo", async () => {
    const db = getDb(url).db;
    const missing = "00000000-0000-0000-0000-000000000000";
    expect(listRepoBranches(db, missing, fakeGit)).rejects.toThrow("repo not found");
  });

  it("provisions a scratch workspace to active and creates its root folder", async () => {
    const db = getDb(url).db;
    const ws = await createWorkspace(db, config, { name: "scratchpad", repoIds: [] });

    const events: string[] = [];
    await provisionWorkspace(db, ws.id, (e) => void events.push(e.type), fakeGit);

    expect(events).toContain("done");
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    expect(detail?.repos.length).toBe(0);
    expect(existsSync(join(workspacesRoot, "scratchpad"))).toBe(true);
  });

  it("writes AGENTS.md and CLAUDE.md to the workspace root describing the repos", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "feature with docs", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const detail = await getWorkspace(db, ws.id);
    const agents = readFileSync(`${detail?.rootPath}/AGENTS.md`, "utf-8");
    expect(agents).toContain("# Workspace: feature with docs");
    expect(agents).toContain("widget");
    expect(agents).toContain(`branch \`${detail?.repos[0]?.branch}\``);

    const claude = readFileSync(`${detail?.rootPath}/CLAUDE.md`, "utf-8");
    expect(claude).toContain("AGENTS.md");
  });

  it("archives by removing worktrees and recording a summary", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "to-archive", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const result = await archiveWorkspace(
      db,
      ws.id,
      { summary: "did the thing", mergedPrUrl: "https://example/pr/1" },
      fakeGit,
    );
    expect(result.status).toBe("archived");

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("archived");
    expect(detail?.summary).toBe("did the thing");
    expect(detail?.repos[0]?.status).toBe("removed");
  });

  it("auto-includes a linked PR on archive even when it hasn't merged", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "open-pr", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: wr!.id,
      prNumber: 7,
      prUrl: "https://example/pr/7",
      prState: "open",
    });

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.status).toBe("archived");

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.mergedPrUrl).toBe("https://example/pr/7");
  });

  it("prefers a merged PR over an open one when auto-including on archive", async () => {
    const db = getDb(url).db;
    const openRepo = await addRepo();
    const mergedRepo = await addRepo("git@github.com:acme/gadget.git");
    const ws = await createWorkspace(db, config, {
      name: "multi-pr",
      repoIds: [openRepo.id, mergedRepo.id],
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    const wrs = await db.select().from(workspaceRepos).where(eq(workspaceRepos.workspaceId, ws.id));
    const openWr = wrs.find((w) => w.repoId === openRepo.id);
    const mergedWr = wrs.find((w) => w.repoId === mergedRepo.id);
    // Insert the open PR first so a plain first-match fallback would pick it.
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: openWr!.id,
      prNumber: 1,
      prUrl: "https://example/pr/open",
      prState: "open",
    });
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: mergedWr!.id,
      prNumber: 2,
      prUrl: "https://example/pr/merged",
      prState: "merged",
    });

    await archiveWorkspace(db, ws.id, {}, fakeGit);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.mergedPrUrl).toBe("https://example/pr/merged");
  });

  it("records an explicit PR URL over an auto-included one on archive", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "explicit-pr", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: wr!.id,
      prNumber: 3,
      prUrl: "https://example/pr/linked",
      prState: "open",
    });

    await archiveWorkspace(db, ws.id, { mergedPrUrl: "https://example/pr/explicit" }, fakeGit);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.mergedPrUrl).toBe("https://example/pr/explicit");
  });

  it("ignores a closed PR when auto-including on archive", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "closed-pr", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: wr!.id,
      prNumber: 4,
      prUrl: "https://example/pr/closed",
      prState: "closed",
    });

    await archiveWorkspace(db, ws.id, {}, fakeGit);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.mergedPrUrl).toBeNull();
  });

  it("leaves the archived PR URL empty when no PR is linked", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "no-pr", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    await archiveWorkspace(db, ws.id, {}, fakeGit);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.mergedPrUrl).toBeNull();
  });

  it("suffixes the branch when it already exists in the repo", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "collide", repoIds: [repo.id] });

    // show-ref exit 0 => the desired branch already exists, forcing a suffix.
    let addedBranch = "";
    const collidingGit: GitRunner = async (args) => {
      if (args[0] === "symbolic-ref") return { stdout: "origin/main\n", stderr: "", exitCode: 0 };
      if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "worktree" && args[1] === "add") {
        addedBranch = args[3] ?? ""; // ["worktree","add","-b",<branch>,<path>,<base>]
        if (args[4]) mkdirSync(args[4], { recursive: true });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    await provisionWorkspace(db, ws.id, () => {}, collidingGit);
    const expected = `yarvis/collide-${ws.id.slice(0, 8)}`;
    expect(addedBranch).toBe(expected);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.repos[0]?.branch).toBe(expected);
  });

  it("reuses a slug only after the prior workspace is archived", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const a = await createWorkspace(db, config, { name: "Same Name", repoIds: [repo.id] });
    const b = await createWorkspace(db, config, { name: "Same Name", repoIds: [repo.id] });
    expect(a.slug).toBe("same-name");
    expect(b.slug).toBe("same-name-2"); // active slug is taken, so it suffixes

    await provisionWorkspace(db, a.id, () => {}, fakeGit);
    await archiveWorkspace(db, a.id, {}, fakeGit);
    const c = await createWorkspace(db, config, { name: "Same Name", repoIds: [repo.id] });
    expect(c.slug).toBe("same-name"); // archived slug is freed for reuse
  });

  it("stays archiving when one repo's worktree won't remove", async () => {
    const db = getDb(url).db;
    const r1 = await addRepo();
    const created = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "git@github.com:acme/other.git" }),
    });
    const r2 = (await created.json()) as { id: string };
    const ws = await createWorkspace(db, config, { name: "multi", repoIds: [r1.id, r2.id] });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    // Removal fails only for the "other" repo's worktree.
    const failingGit: GitRunner = async (args) => {
      if (
        args[0] === "worktree" &&
        args[1] === "remove" &&
        args[args.length - 1]?.includes("other")
      ) {
        return { stdout: "", stderr: "worktree contains modified files", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await archiveWorkspace(db, ws.id, {}, failingGit);
    expect(result.status).toBe("archiving");
    expect(result.errors.length).toBe(1);

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("archiving");
    expect(detail?.repos.map((r) => r.status).sort()).toEqual(["error", "removed"]);
  });

  it("completes a linked task when the workspace is fully archived", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const [task] = await db.insert(tasks).values({ title: "do it", scope: "daily" }).returning();
    const ws = await createWorkspace(db, config, {
      name: "linked",
      repoIds: [repo.id],
      taskId: task!.id,
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.completedTasks).toBe(1);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(after?.status).toBe("done");
  });

  it("does not complete the linked task on a partial archive", async () => {
    const db = getDb(url).db;
    const r1 = await addRepo();
    const created = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "git@github.com:acme/other.git" }),
    });
    const r2 = (await created.json()) as { id: string };
    const [task] = await db.insert(tasks).values({ title: "t", scope: "daily" }).returning();
    const ws = await createWorkspace(db, config, {
      name: "partial",
      repoIds: [r1.id, r2.id],
      taskId: task!.id,
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const failingGit: GitRunner = async (args) => {
      if (
        args[0] === "worktree" &&
        args[1] === "remove" &&
        args[args.length - 1]?.includes("other")
      ) {
        return { stdout: "", stderr: "dirty", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const result = await archiveWorkspace(db, ws.id, {}, failingGit);
    expect(result.status).toBe("archiving");
    expect(result.completedTasks).toBe(0);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(after?.status).toBe("open"); // stays open so the archive can be retried
  });

  it("leaves an already-done linked task's completedAt unchanged", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ts = new Date("2026-01-01T00:00:00Z");
    const [task] = await db
      .insert(tasks)
      .values({ title: "done", scope: "daily", status: "done", completedAt: ts })
      .returning();
    const ws = await createWorkspace(db, config, {
      name: "done-task",
      repoIds: [repo.id],
      taskId: task!.id,
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.completedTasks).toBe(0); // only OPEN tasks are completed
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(after?.completedAt?.getTime()).toBe(ts.getTime());
  });

  it("does not complete a task unlinked before archive", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const [task] = await db.insert(tasks).values({ title: "t", scope: "daily" }).returning();
    const ws = await createWorkspace(db, config, {
      name: "unlinkme",
      repoIds: [repo.id],
      taskId: task!.id,
    });
    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    expect(await unlinkTask(db, ws.id, task!.id)).toBe(true);

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.completedTasks).toBe(0);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(after?.status).toBe("open");
  });

  it("completes provisioning even when a setup script fails (repo -> error)", async () => {
    const db = getDb(url).db;
    // A repo whose setup script exits non-zero leaves that repo in error.
    const created = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "git@github.com:acme/flaky.git", setupScript: "exit 3" }),
    });
    const repo = (await created.json()) as { id: string };
    const ws = await createWorkspace(db, config, { name: "flaky-task", repoIds: [repo.id] });

    await provisionWorkspace(db, ws.id, () => {}, fakeGit);
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("error");
    expect(detail?.repos[0]?.status).toBe("error");
    expect(detail?.repos[0]?.setupExitCode).toBe(3);
  });
});
