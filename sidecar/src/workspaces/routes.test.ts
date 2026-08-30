import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  attentionItems,
  issueLinks,
  tasks,
  workspaceRepoPr,
  workspaceRepos,
} from "../db/schema.ts";
import type { StartClaudeSessionInput } from "./claudeSession.ts";
import type { GitRunner } from "./git.ts";
import {
  archiveWorkspace,
  assertSafeBranchName,
  createWorkspace,
  getWorkspace,
  ignoreWorkspaceError,
  listRepoBranches,
  type ProvisionEvent,
  provisionWorkspace,
  resumeKickOffs,
  startArchiveWorkspace,
  unlinkTask,
} from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-ws-root-"));

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

/** Like fakeGit, but also lays down .claude/skills and .claude/agents in the
 * worktree, as a checkout of a repo carrying them would. */
const skillsGit: GitRunner = async (args, opts) => {
  const res = await fakeGit(args, opts);
  if (args[0] === "worktree" && args[1] === "add") {
    const path = args[2] === "-b" ? args[4] : args[2];
    if (path) {
      mkdirSync(join(path, ".claude", "skills"), { recursive: true });
      mkdirSync(join(path, ".claude", "agents"), { recursive: true });
    }
  }
  return res;
};

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr, tasks, issue_links RESTART IDENTITY CASCADE`;
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

/** Refuses a worktree removal until it's forced, as a dirty worktree does. */
const dirtyGit: GitRunner = async (args, opts) => {
  if (args[0] === "worktree" && args[1] === "remove" && !args.includes("--force")) {
    return { stdout: "", stderr: "worktree contains modified files", exitCode: 1 };
  }
  return fakeGit(args, opts);
};

/** Polls a workspace the way a client does, for work finishing in the
 *  background (an archive's worktree teardown). */
async function waitFor(
  id: string,
  done: (detail: NonNullable<Awaited<ReturnType<typeof getWorkspace>>>) => boolean,
  what: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const detail = await getWorkspace(db, id);
    if (detail && done(detail)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workspace ${id} never ${what}`);
}

const waitForStatus = (id: string, status: string) =>
  waitFor(id, (d) => d.status === status, `reached ${status}`);

const waitForError = (id: string) => waitFor(id, (d) => d.error !== null, "recorded an error");

/** The workspace row flips to `archived` before the archive clears what the
 *  workspace was flagging, so waiting on the status is not enough to read the
 *  attention item's settled state. */
async function waitForAttention(workspaceId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [item] = await db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.workspaceId, workspaceId));
    if (item?.status === status) return item;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workspace ${workspaceId}'s attention never reached ${status}`);
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

  it("lists each workspace's cached PR state so the sidebar can flag it", async () => {
    const repo = await addRepo();
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "with pr", repoIds: [repo.id] }),
    });
    const ws = (await created.json()) as { id: string };
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({
      workspaceRepoId: wr!.id,
      prNumber: 12,
      prUrl: "https://github.com/acme/widget/pull/12",
      prState: "open",
      isDraft: false,
      mergeable: "clean",
      checkRollup: "failure",
      reviewDecision: "approved",
    });

    const res = await app.request("/api/workspaces", { headers: auth });
    const list = (await res.json()) as { prs: Record<string, unknown>[] }[];
    expect(list[0]?.prs).toEqual([
      {
        repoName: "widget",
        prNumber: 12,
        prState: "open",
        isDraft: false,
        mergeable: "clean",
        checkRollup: "failure",
        reviewDecision: "approved",
      },
    ]);
  });

  it("keeps a multi-repo workspace's names whole while listing only its PRs", async () => {
    const widget = await addRepo();
    const gadget = await addRepo("git@github.com:acme/gadget.git");
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "two repos", repoIds: [widget.id, gadget.id] }),
    });
    const ws = (await created.json()) as { id: string };
    const wrs = await db.select().from(workspaceRepos).where(eq(workspaceRepos.workspaceId, ws.id));
    const withPr = wrs.find((wr) => wr.worktreePath.endsWith("gadget"));
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: withPr!.id, prNumber: 3, prState: "open" });

    const res = await app.request("/api/workspaces", { headers: auth });
    const list = (await res.json()) as { repoNames: string[]; prs: { repoName: string }[] }[];
    expect(list[0]?.repoNames.sort()).toEqual(["gadget", "widget"]);
    expect(list[0]?.prs.map((pr) => pr.repoName)).toEqual(["gadget"]);
  });

  it("drops the PR of a repo torn down by an archive, whose cache is frozen", async () => {
    const repo = await addRepo();
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "archived", repoIds: [repo.id] }),
    });
    const ws = (await created.json()) as { id: string };
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db
      .insert(workspaceRepoPr)
      .values({ workspaceRepoId: wr!.id, prNumber: 8, prState: "open", checkRollup: "failure" });
    await db.update(workspaceRepos).set({ status: "removed" }).where(eq(workspaceRepos.id, wr!.id));

    const res = await app.request("/api/workspaces", { headers: auth });
    const list = (await res.json()) as { prs: unknown[] }[];
    expect(list[0]?.prs).toEqual([]);
  });

  it("leaves a repo with no PR out of the list row's PR states", async () => {
    const repo = await addRepo();
    await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "no pr", repoIds: [repo.id] }),
    });

    const res = await app.request("/api/workspaces", { headers: auth });
    const list = (await res.json()) as { prs: unknown[] }[];
    expect(list[0]?.prs).toEqual([]);
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

  it("does not match across providers on a shared PR number", async () => {
    // A GitHub repo caches PR #55; an Azure query for id 55 must not resolve it,
    // even though the number matches — the clone-URL provider disambiguates.
    const repo = await addRepo("git@github.com:acme/widget.git");
    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "provider collision", repoIds: [repo.id] }),
    });
    const ws = (await created.json()) as { id: string };
    const [wr] = await db
      .select()
      .from(workspaceRepos)
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber: 55 });

    const res = await app.request(
      "/api/workspaces/for-pr?provider=azure&org=acme&project=Shop&repo=widget&number=55",
      { headers: auth },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it("reads a file from a worktree, and writes an edit back", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "editing", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const detail = await getWorkspace(db, ws.id);
    const wr = detail?.repos[0];
    writeFileSync(join(wr?.worktreePath ?? "", "a.ts"), "const a = 1;\n");

    const read = await app.request(`/api/workspaces/${ws.id}/repos/${wr?.id}/file?path=a.ts`, {
      headers: auth,
    });
    expect(read.status).toBe(200);
    const file = (await read.json()) as { content: string; hash: string; unreadable: null };
    expect(file.content).toBe("const a = 1;\n");

    const saved = await app.request(`/api/workspaces/${ws.id}/repos/${wr?.id}/file`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ path: "a.ts", content: "const a = 2;\n", expectedHash: file.hash }),
    });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(wr?.worktreePath ?? "", "a.ts"), "utf-8")).toBe("const a = 2;\n");
  });

  it("refuses a save whose base is no longer what is on disk", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "conflict", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const detail = await getWorkspace(db, ws.id);
    const wr = detail?.repos[0];
    const path = join(wr?.worktreePath ?? "", "a.ts");
    writeFileSync(path, "const a = 1;\n");
    const read = await app.request(`/api/workspaces/${ws.id}/repos/${wr?.id}/file?path=a.ts`, {
      headers: auth,
    });
    const { hash } = (await read.json()) as { hash: string };
    // The agent working in this worktree gets there first.
    writeFileSync(path, "const a = 3;\n");

    const saved = await app.request(`/api/workspaces/${ws.id}/repos/${wr?.id}/file`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ path: "a.ts", content: "const a = 2;\n", expectedHash: hash }),
    });

    expect(saved.status).toBe(409);
    expect(readFileSync(path, "utf-8")).toBe("const a = 3;\n");
  });

  it("refuses a file path that leaves the worktree", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "traversal", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const detail = await getWorkspace(db, ws.id);
    const wr = detail?.repos[0];

    const read = await app.request(
      `/api/workspaces/${ws.id}/repos/${wr?.id}/file?path=${encodeURIComponent("../../etc/hosts")}`,
      { headers: auth },
    );
    expect(read.status).toBe(400);

    const saved = await app.request(`/api/workspaces/${ws.id}/repos/${wr?.id}/file`, {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({
        path: "../escape.txt",
        content: "x",
        expectedHash: "0".repeat(64),
      }),
    });
    expect(saved.status).toBe(400);
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

describe("workspace issue links", () => {
  async function makeWorkspace(name: string): Promise<string> {
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name, repoIds: [] }),
    });
    return ((await res.json()) as { id: string }).id;
  }

  const githubIssue = {
    provider: "github",
    sourceKey: "acme/widget",
    externalId: "42",
    title: "Fix the thing",
    url: "https://github.com/acme/widget/issues/42",
  };

  it("links a GitHub issue and surfaces it on the workspace detail", async () => {
    const id = await makeWorkspace("link gh");
    const res = await app.request(`/api/workspaces/${id}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });
    expect(res.status).toBe(200);

    const detail = await app.request(`/api/workspaces/${id}`, { headers: auth });
    const body = (await detail.json()) as {
      issues: { externalId: string; localStatus: string; title: string; url: string }[];
    };
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0]?.externalId).toBe("42");
    expect(body.issues[0]?.localStatus).toBe("in_progress");
    expect(body.issues[0]?.title).toBe("Fix the thing");
    expect(body.issues[0]?.url).toBe("https://github.com/acme/widget/issues/42");
  });

  it("404s when linking to a workspace that doesn't exist", async () => {
    const res = await app.request("/api/workspaces/00000000-0000-0000-0000-000000000000/issues", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-http(s) url", async () => {
    const id = await makeWorkspace("bad url");
    const res = await app.request(`/api/workspaces/${id}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ ...githubIssue, url: "javascript:alert(1)" }),
    });
    expect(res.status).toBe(400);
  });

  it("re-links the same issue idempotently, re-pointing it at the new workspace", async () => {
    const first = await makeWorkspace("first");
    const second = await makeWorkspace("second");
    await app.request(`/api/workspaces/${first}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });
    await app.request(`/api/workspaces/${second}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });

    const rows = await db.select().from(issueLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceId).toBe(second);
  });

  it("links a JIRA ticket entered by key", async () => {
    const id = await makeWorkspace("link jira");
    const res = await app.request(`/api/workspaces/${id}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ provider: "jira", sourceKey: "PROJ", externalId: "PROJ-7" }),
    });
    expect(res.status).toBe(200);
    const detail = await app.request(`/api/workspaces/${id}`, { headers: auth });
    const body = (await detail.json()) as { issues: { provider: string }[] };
    expect(body.issues[0]?.provider).toBe("jira");
  });

  it("rejects an unknown provider", async () => {
    const id = await makeWorkspace("bad provider");
    const res = await app.request(`/api/workspaces/${id}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ ...githubIssue, provider: "gitlab" }),
    });
    expect(res.status).toBe(400);
  });

  it("unlinks an issue and 404s when it isn't linked", async () => {
    const id = await makeWorkspace("unlink");
    await app.request(`/api/workspaces/${id}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });
    const query = new URLSearchParams({
      provider: "github",
      sourceKey: "acme/widget",
      externalId: "42",
    });
    const del = await app.request(`/api/workspaces/${id}/issues?${query}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(200);
    expect(await db.select().from(issueLinks)).toHaveLength(0);

    const again = await app.request(`/api/workspaces/${id}/issues?${query}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(again.status).toBe(404);
  });

  it("does not unlink an issue owned by a different workspace", async () => {
    const first = await makeWorkspace("owner-a");
    const second = await makeWorkspace("owner-b");
    await app.request(`/api/workspaces/${first}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });
    // Re-point the single link at the second workspace.
    await app.request(`/api/workspaces/${second}/issues`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(githubIssue),
    });

    const query = new URLSearchParams({
      provider: "github",
      sourceKey: "acme/widget",
      externalId: "42",
    });
    // Deleting via the first (no longer owning) workspace must not touch the link.
    const del = await app.request(`/api/workspaces/${first}/issues?${query}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(del.status).toBe(404);
    const rows = await db.select().from(issueLinks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workspaceId).toBe(second);
  });
});

describe("provision + archive (injected git runner)", () => {
  it("provisions every repo to ready and marks the workspace active", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "feature", repoIds: [repo.id] });

    const events: string[] = [];
    await provisionWorkspace(db, ws.id, (e) => void events.push(e.type), { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: trackingGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: orderingGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, (e) => void events.push(e.type), { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    const agents = readFileSync(`${detail?.rootPath}/AGENTS.md`, "utf-8");
    expect(agents).toContain("# Workspace: feature with docs");
    expect(agents).toContain("widget");
    expect(agents).toContain(`branch \`${detail?.repos[0]?.branch}\``);

    const claude = readFileSync(`${detail?.rootPath}/CLAUDE.md`, "utf-8");
    expect(claude).toContain("AGENTS.md");
  });

  it("registers each repo's .claude skills and agents in the root settings.json", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "skills ws", repoIds: [repo.id] });

    await provisionWorkspace(db, ws.id, () => {}, { runner: skillsGit });

    const detail = await getWorkspace(db, ws.id);
    const worktree = detail?.repos[0]?.worktreePath ?? "";
    const settings = JSON.parse(
      readFileSync(join(detail?.rootPath ?? "", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.skills.enabled).toBe(true);
    expect(settings.skills.paths).toContain(join(worktree, ".claude", "skills"));
    expect(settings.agents.enabled).toBe(true);
    expect(settings.agents.paths).toContain(join(worktree, ".claude", "agents"));
  });

  it("points a Claude session at the Yarvis MCP endpoint via .mcp.json", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "mcp ws", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    const mcp = JSON.parse(readFileSync(join(detail?.rootPath ?? "", ".mcp.json"), "utf-8"));
    expect(mcp.mcpServers.yarvis.type).toBe("http");
    // The token is referenced, never written: the session's environment supplies it.
    expect(JSON.stringify(mcp)).toContain("YARVIS_MCP_TOKEN");
  });

  it("omits skills/agents keys when a repo has no .claude directory", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "bare ws", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    const settings = JSON.parse(
      readFileSync(join(detail?.rootPath ?? "", ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.skills).toBeUndefined();
    expect(settings.agents).toBeUndefined();
  });

  it("registers skills alongside the attention hooks in the same settings.json", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "merge ws", repoIds: [repo.id] });

    await provisionWorkspace(db, ws.id, () => {}, { runner: skillsGit });

    const detail = await getWorkspace(db, ws.id);
    const settings = JSON.parse(
      readFileSync(join(detail?.rootPath ?? "", ".claude", "settings.json"), "utf-8"),
    );
    // Both the attention hooks and the registered skills coexist in one file.
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.skills.enabled).toBe(true);
    expect(settings.agents.enabled).toBe(true);
  });

  it("archives by removing worktrees and recording a summary", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "to-archive", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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

    await provisionWorkspace(db, ws.id, () => {}, { runner: collidingGit });
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

    await provisionWorkspace(db, a.id, () => {}, { runner: fakeGit });
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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

  it("returns from a background archive before the worktrees are gone", async () => {
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "bg-archive", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    // Hold the removal open, so the call can only return by not waiting for it.
    let releaseRemoval: () => void = () => {};
    const removalHeld = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const slowGit: GitRunner = async (args, opts) => {
      if (args[0] === "worktree" && args[1] === "remove") await removalHeld;
      return fakeGit(args, opts);
    };

    const result = await startArchiveWorkspace(db, ws.id, { summary: "did it" }, slowGit);
    expect(result.status).toBe("archiving");

    const midway = await getWorkspace(db, ws.id);
    expect(midway?.status).toBe("archiving");
    expect(midway?.summary).toBe("did it"); // recorded before the teardown runs
    expect(midway?.repos[0]?.status).toBe("ready"); // worktree still there

    releaseRemoval();
    const after = await waitForStatus(ws.id, "archived");
    expect(after.repos[0]?.status).toBe("removed");
  });

  it("clears the recorded failure when a blocked archive is retried with force", async () => {
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "dirty", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    await startArchiveWorkspace(db, ws.id, {}, dirtyGit);
    const blocked = await waitForError(ws.id);
    expect(blocked.status).toBe("archiving");
    expect(blocked.repos[0]?.status).toBe("error");

    await startArchiveWorkspace(db, ws.id, { force: true }, dirtyGit);
    const after = await waitForStatus(ws.id, "archived");
    // Cleared, so a poller can read `archiving` + no error as "still running".
    expect(after.error).toBeNull();
    expect(after.repos[0]?.status).toBe("removed");
  });

  it("flags a blocked archive on the attention stream", async () => {
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "needs-me", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    await startArchiveWorkspace(db, ws.id, {}, dirtyGit);
    await waitForError(ws.id);

    const [item] = await db
      .select()
      .from(attentionItems)
      .where(eq(attentionItems.workspaceId, ws.id));
    expect(item?.kind).toBe("error");
    expect(item?.status).toBe("pending");
    expect(item?.title).toBe("needs-me");
    expect(item?.body).toContain("worktree contains modified files");
    // Session-less, so opening the workspace clears it; the target lands there.
    expect(item?.sessionKey).toBeNull();
    expect(item?.navTarget).toEqual({ type: "workspace", workspaceId: ws.id });
  });

  it("resolves the workspace's pending attention once the archive lands", async () => {
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "quiet", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    await db.insert(attentionItems).values({
      source: "claude-hook",
      sessionKey: `ws-claude:${ws.id}`,
      workspaceId: ws.id,
      kind: "idle",
      title: "quiet",
    });

    await startArchiveWorkspace(db, ws.id, {}, fakeGit);
    await waitForStatus(ws.id, "archived");

    const item = await waitForAttention(ws.id, "resolved");
    expect(item.status).toBe("resolved");
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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

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
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    expect(await unlinkTask(db, ws.id, task!.id)).toBe(true);

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.completedTasks).toBe(0);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(after?.status).toBe("open");
  });

  /** Reports a worktree registered at `worktreePath` on `branch`, and refuses to
   *  add another, the way git does once the path is taken. */
  const adoptedGit =
    (worktreePath: string, branch: string | null): GitRunner =>
    async (args, opts) => {
      if (args[0] === "worktree" && args[1] === "list") {
        const head = branch ? `branch refs/heads/${branch}` : "detached";
        return {
          stdout: `worktree ${worktreePath}\0HEAD abc\0${head}\0\0`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (args[0] === "worktree" && args[1] === "add") {
        return { stdout: "", stderr: `fatal: '${worktreePath}' already exists`, exitCode: 128 };
      }
      return fakeGit(args, opts);
    };

  /** A repo whose setup script fails, provisioned once so its workspace is
   *  parked in `error` with the worktree already cut. */
  async function failedProvision(name: string, issuePrompt?: string) {
    const db = getDb(url).db;
    const created = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: `git@github.com:acme/${name}.git`, setupScript: "exit 3" }),
    });
    const repo = (await created.json()) as { id: string };
    const ws = await createWorkspace(db, config, { name, repoIds: [repo.id], issuePrompt });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("error");
    if (!detail) throw new Error("the failed provision left no workspace");
    return { db, repo, ws, detail };
  }

  /** Points the repo's setup script at something that succeeds, so a retry has
   *  a reason to land differently from the run that failed. */
  const fixSetupScript = (repoId: string) =>
    app.request(`/api/repos/${repoId}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ setupScript: "true" }),
    });

  it("adopts the worktree the failed attempt cut, so the retry can recover it", async () => {
    // The reported bug: everything after `worktree add` can fail, and the retry
    // then died on the one step that had actually worked, stranding the space.
    const { db, repo, ws, detail } = await failedProvision("adopt-worktree");
    const worktreePath = detail.repos[0]?.worktreePath ?? "";
    // The branch git reports is deliberately not the one on the row: whatever is
    // checked out there is where the work is, and the row has to follow it.
    const checkedOut = "yarvis/adopt-worktree-abcd1234";
    expect(detail.repos[0]?.branch).not.toBe(checkedOut);

    await fixSetupScript(repo.id);
    await provisionWorkspace(db, ws.id, () => {}, {
      runner: adoptedGit(worktreePath, checkedOut),
    });

    const after = await getWorkspace(db, ws.id);
    expect(after?.status).toBe("active");
    expect(after?.repos[0]?.status).toBe("ready");
    expect(after?.repos[0]?.branch).toBe(checkedOut);
    // Recovered in place rather than cut a second time beside it.
    expect(after?.repos[0]?.worktreePath).toBe(worktreePath);
  });

  it("refuses to adopt a detached worktree rather than record a branch it isn't on", async () => {
    // The branch column is what every later merge, push and diff reads, so
    // recording the row's branch for a detached checkout would push a ref that
    // isn't the work sitting there.
    const { db, repo, ws, detail } = await failedProvision("detached");
    await fixSetupScript(repo.id);
    await provisionWorkspace(db, ws.id, () => {}, {
      runner: adoptedGit(detail.repos[0]?.worktreePath ?? "", null),
    });

    const after = await getWorkspace(db, ws.id);
    expect(after?.status).toBe("error");
    expect(after?.repos[0]?.error).toContain("detached HEAD");
  });

  it("cuts a distinct branch on a retry rather than adopting one it didn't create", async () => {
    // `error` says a previous attempt happened, not that this row is what cut the
    // branch — an attempt that failed while cloning never got that far, and an
    // archived workspace frees its slug while leaving its branch behind. Reusing
    // on that evidence would start a new workspace on an old one's commits.
    const { db, repo, ws, detail } = await failedProvision("collide-on-retry");
    const worktreePath = detail.repos[0]?.worktreePath ?? "";
    rmSync(worktreePath, { recursive: true, force: true });
    await fixSetupScript(repo.id);

    // show-ref exit 0 => a local branch of that name is already there.
    let added: string[] = [];
    const branchLeftBehind: GitRunner = async (args, opts) => {
      if (args[0] === "show-ref") return { stdout: "", stderr: "", exitCode: 0 };
      if (args[0] === "worktree" && args[1] === "add") added = args;
      return fakeGit(args, opts);
    };
    await provisionWorkspace(db, ws.id, () => {}, { runner: branchLeftBehind });

    const expected = `yarvis/collide-on-retry-${ws.id.slice(0, 8)}`;
    expect(added).toEqual(["worktree", "add", "-b", expected, worktreePath, "origin/main"]);
    expect((await getWorkspace(db, ws.id))?.repos[0]?.branch).toBe(expected);
  });

  it("names what is occupying the worktree path on the repo that failed", async () => {
    const db = getDb(url).db;
    const repo = await addRepo("git@github.com:acme/occupied.git");
    const ws = await createWorkspace(db, config, { name: "occupied", repoIds: [repo.id] });
    const detail = await getWorkspace(db, ws.id);
    const worktreePath = detail?.repos[0]?.worktreePath ?? "";
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "stray"), "");

    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const after = await getWorkspace(db, ws.id);
    expect(after?.repos[0]?.status).toBe("error");
    // Actionable, rather than git's own "already exists" with nothing to do.
    expect(after?.repos[0]?.error).toContain("remove it to provision again");
  });

  it("puts an ignored failure back in service, failed repos and all", async () => {
    const { db, ws } = await failedProvision("ignored");

    const after = await ignoreWorkspaceError(db, ws.id);
    // Usable again — which is what the agent session and the run buttons wait on.
    expect(after?.status).toBe("active");
    expect(after?.error).toBeNull();
    // The repo still reads as failed, so its badge, setup log and the retry
    // button all still say what happened.
    expect(after?.repos[0]?.status).toBe("error");
    expect(after?.repos[0]?.setupExitCode).toBe(3);
  });

  it("refuses to ignore anything but a failed provision", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "healthy", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    await expect(ignoreWorkspaceError(db, ws.id)).rejects.toThrow(
      "provisioning failed can be ignored",
    );
  });

  it("refuses to ignore while a run is still going, which would overwrite it", async () => {
    const db = getDb(url).db;
    const repo = await addRepo("git@github.com:acme/mid-run.git");
    const ws = await createWorkspace(db, config, { name: "mid run", repoIds: [repo.id] });

    let releaseRun = () => {};
    const held = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const slowGit: GitRunner = async (args, opts) => {
      const res = await fakeGit(args, opts);
      if (args[0] === "worktree" && args[1] === "add") await held;
      return res;
    };
    const run = provisionWorkspace(db, ws.id, () => {}, { runner: slowGit });
    await waitFor(ws.id, (d) => d.repos[0]?.status === "provisioning", "started provisioning");

    await expect(ignoreWorkspaceError(db, ws.id)).rejects.toThrow("still running");
    releaseRun();
    await run;
  });

  it("finishes a kick-off the failed provision left owed when its error is ignored", async () => {
    // Otherwise the prompt outlives the ignore, and the startup sweep re-drives
    // provisioning and puts the workspace straight back into `error`.
    const { db, ws, detail } = await failedProvision("ignored kickoff", "implement the ticket");
    expect(detail.pendingIssuePrompt).toBe("implement the ticket");

    const started: StartClaudeSessionInput[] = [];
    const after = await ignoreWorkspaceError(db, ws.id, {
      startSession: async (input) => {
        started.push(input);
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    expect(after?.status).toBe("active");
    expect(after?.pendingIssuePrompt).toBeNull();
    expect(started).toHaveLength(1);
    expect(started[0]?.instruction ?? "").toContain(".yarvis/issue-prompt.md");
    expect(readFileSync(join(detail.rootPath, ".yarvis", "issue-prompt.md"), "utf-8")).toBe(
      "implement the ticket",
    );
  });

  it("drops the prompt even when the session won't start, so the ignore sticks", async () => {
    // A launch failure is the common one (the agent isn't logged in) and is
    // swallowed by design. Leaving the prompt set would have `resumeKickOffs`
    // re-provision on the next start and undo the ignore; the ticket is still on
    // disk for a session started by hand.
    const { db, ws, detail } = await failedProvision("launch fails", "implement the ticket");

    const after = await ignoreWorkspaceError(db, ws.id, {
      startSession: async () => {
        throw new Error("agent not logged in");
      },
    });

    expect(after?.status).toBe("active");
    expect(after?.pendingIssuePrompt).toBeNull();
    expect(readFileSync(join(detail.rootPath, ".yarvis", "issue-prompt.md"), "utf-8")).toBe(
      "implement the ticket",
    );
  });

  it("lays down the workspace root files a failed run never reached", async () => {
    // A run that threw outright never wrote them, and the ignore is about to
    // start an agent session in that root.
    const db = getDb(url).db;
    const repo = await addRepo("git@github.com:acme/never-cloned.git");
    const ws = await createWorkspace(db, config, { name: "never cloned", repoIds: [repo.id] });
    const failingGit: GitRunner = async (args) => {
      if (args[0] === "clone") return { stdout: "", stderr: "network is down", exitCode: 128 };
      return fakeGit(args, {});
    };
    await provisionWorkspace(db, ws.id, () => {}, { runner: failingGit });

    const after = await ignoreWorkspaceError(db, ws.id);
    const root = after?.rootPath ?? "";
    expect(existsSync(join(root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(root, ".claude", "settings.json"))).toBe(true);
  });

  it("ignores over HTTP without leaking the pending prompt", async () => {
    const { ws } = await failedProvision("ignored over http", "implement the ticket");

    const res = await app.request(`/api/workspaces/${ws.id}/ignore-error`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("active");
    // The sidecar's own bookkeeping, kept off every workspace response.
    expect(body).not.toHaveProperty("pendingIssuePrompt");

    // And a second click, on a workspace already recovered, is refused rather
    // than taking the view down with a 500.
    const again = await app.request(`/api/workspaces/${ws.id}/ignore-error`, {
      method: "POST",
      headers: auth,
    });
    expect(again.status).toBe(400);
  });

  it("answers 404 for a workspace that isn't there", async () => {
    const res = await app.request(
      "/api/workspaces/00000000-0000-4000-8000-000000000000/ignore-error",
      { method: "POST", headers: auth },
    );
    expect(res.status).toBe(404);
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

    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("error");
    expect(detail?.repos[0]?.status).toBe("error");
    expect(detail?.repos[0]?.setupExitCode).toBe(3);
  });
});

/**
 * Kicking off work is a multi-step sequence (create → provision → write the
 * prompt file → launch the agent). The UI used to own the steps after create,
 * so navigating away mid-provision dropped the ticket with no way back. These
 * cover the pieces that make it resumable: the prompt lives on the row, and
 * provisioning — not its caller — puts it on disk.
 */
describe("resumable start-work kick-off", () => {
  it("stores the kick-off prompt on the workspace, sanitized", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "kickoff",
      repoIds: [repo.id],
      // A zero-width joiner is the kind of hidden character sanitizing strips
      // before the prompt can reach an auto-approved agent session.
      issuePrompt: "implement‍ the ticket",
    });

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.pendingIssuePrompt).toBe("implement the ticket");
  });

  it("writes the prompt file itself, so an absent caller can't lose the ticket", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "writes prompt",
      repoIds: [repo.id],
      issuePrompt: "# Ticket\n\nimplement the ticket",
    });

    // No emit callback at all: the client that started this has gone away.
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    expect(readFileSync(join(detail?.rootPath ?? "", ".yarvis", "issue-prompt.md"), "utf-8")).toBe(
      "# Ticket\n\nimplement the ticket",
    );
    // Still pending: the prompt is dropped only once a session has it.
    expect(detail?.pendingIssuePrompt).toBe("# Ticket\n\nimplement the ticket");
  });

  it("leaves no prompt file for a workspace that wasn't kicked off from a ticket", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "no ticket", repoIds: [repo.id] });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    expect(existsSync(join(detail?.rootPath ?? "", ".yarvis", "issue-prompt.md"))).toBe(false);
  });

  it("a second drive follows the run in flight instead of failing", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "reopened", repoIds: [repo.id] });

    // Hold the first drive open until the second has joined, the way reopening a
    // workspace mid-provision does.
    let releaseFirst = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowGit: GitRunner = async (args, opts) => {
      const res = await fakeGit(args, opts);
      if (args[0] === "worktree" && args[1] === "add") await held;
      return res;
    };

    const firstEvents: ProvisionEvent[] = [];
    const first = provisionWorkspace(db, ws.id, (e) => void firstEvents.push(e), {
      runner: slowGit,
    });
    await waitFor(ws.id, (d) => d.repos[0]?.status === "provisioning", "started provisioning");

    const secondEvents: ProvisionEvent[] = [];
    const second = provisionWorkspace(db, ws.id, (e) => void secondEvents.push(e), {
      runner: fakeGit,
    });
    releaseFirst();
    await Promise.all([first, second]);

    // The joiner sees the run through to the end, including the events it missed.
    expect(secondEvents.map((e) => e.type)).toContain("repo-start");
    expect(secondEvents.map((e) => e.type)).toContain("done");
    expect(secondEvents.some((e) => e.type === "error")).toBe(false);
    // Byte-for-byte the same sequence: nothing lost or doubled across the
    // snapshot/subscribe seam, and the replay stayed ahead of the live events.
    expect(secondEvents).toEqual(firstEvents);
    expect((await getWorkspace(db, ws.id))?.status).toBe("active");
  });

  it("finishes the kick-off even when the caller's stream throws on every write", async () => {
    // The reported bug is the user navigating away, which makes the stream write
    // *fail* — not merely go unread. Every other test passes an inert emit, so
    // without this one the swallow in `safeEmit` could be deleted unnoticed and
    // a cleanly provisioned workspace would land on `error`.
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "stream closed",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });

    await provisionWorkspace(
      db,
      ws.id,
      () => {
        throw new Error("stream closed");
      },
      { runner: fakeGit },
    );

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    expect(existsSync(join(detail?.rootPath ?? "", ".yarvis", "issue-prompt.md"))).toBe(true);
  });

  it("keeps the prompt and offers a retry when the prompt file can't be written", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "unwritable prompt",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });
    const created = await getWorkspace(db, ws.id);
    // A file where the `.yarvis` directory needs to go, so the mkdir fails.
    mkdirSync(created?.rootPath ?? "", { recursive: true });
    writeFileSync(join(created?.rootPath ?? "", ".yarvis"), "");

    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    // Never `active` without the file the agent is launched to read.
    expect(detail?.status).toBe("error");
    expect(detail?.error).toContain("issue prompt file");
    expect(detail?.pendingIssuePrompt).toBe("implement the ticket");
  });

  it("rewrites the prompt file when a failed provision is retried", async () => {
    // The resume path: a kick-off that failed still carries its ticket, and the
    // retry is what gets it onto disk — including when every repo is already
    // provisioned and there is no git work left to redo.
    const db = getDb(url).db;
    const created = await app.request("/api/repos", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ cloneUrl: "git@github.com:acme/retry.git", setupScript: "exit 1" }),
    });
    const repo = (await created.json()) as { id: string };
    const ws = await createWorkspace(db, config, {
      name: "retried kickoff",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });

    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });
    const failed = await getWorkspace(db, ws.id);
    expect(failed?.status).toBe("error");
    expect(existsSync(join(failed?.rootPath ?? "", ".yarvis", "issue-prompt.md"))).toBe(false);
    expect(failed?.pendingIssuePrompt).toBe("implement the ticket");

    // Fix what failed, then retry the way the workspace's button does.
    await app.request(`/api/repos/${repo.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ setupScript: "true" }),
    });
    await db
      .update(workspaceRepos)
      .set({ status: "pending", error: null })
      .where(eq(workspaceRepos.workspaceId, ws.id));
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    expect(readFileSync(join(detail?.rootPath ?? "", ".yarvis", "issue-prompt.md"), "utf-8")).toBe(
      "implement the ticket",
    );
  });

  it("stops following when the follower goes away, without stopping the run", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "follower left", repoIds: [repo.id] });

    let releaseFirst = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const slowGit: GitRunner = async (args, opts) => {
      const res = await fakeGit(args, opts);
      if (args[0] === "worktree" && args[1] === "add") await held;
      return res;
    };

    const first = provisionWorkspace(db, ws.id, () => {}, { runner: slowGit });
    await waitFor(ws.id, (d) => d.repos[0]?.status === "provisioning", "started provisioning");

    const gone = new AbortController();
    const followerEvents: ProvisionEvent[] = [];
    const follower = provisionWorkspace(db, ws.id, (e) => void followerEvents.push(e), {
      signal: gone.signal,
    });
    gone.abort();
    await follower;
    const seenBeforeLeaving = followerEvents.length;

    releaseFirst();
    await first;

    // The run finished for everyone else; the follower stopped where it left off.
    expect(followerEvents).toHaveLength(seenBeforeLeaving);
    expect(followerEvents.some((e) => e.type === "done")).toBe(false);
    expect((await getWorkspace(db, ws.id))?.status).toBe("active");
  });

  it("launches the session on the ticket and drops the prompt it was owed", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "launched",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });

    const started: StartClaudeSessionInput[] = [];
    await provisionWorkspace(db, ws.id, () => {}, {
      runner: fakeGit,
      startSession: async (input) => {
        started.push(input);
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
    });

    const detail = await getWorkspace(db, ws.id);
    expect(detail?.status).toBe("active");
    // The session runs at the workspace root, where the prompt file was seeded,
    // and starts on the ticket rather than waiting to be told.
    expect(started).toHaveLength(1);
    expect(started[0]?.cwd).toBe(detail?.rootPath ?? "");
    expect(started[0]?.instruction ?? "").toContain(".yarvis/issue-prompt.md");
    // Started at the machine, so not remotely controllable.
    expect(started[0]?.remoteControl).toBe(false);
    // Nothing owed any more.
    expect(detail?.pendingIssuePrompt).toBeNull();
  });

  it("keeps the prompt when the session fails to start, so a restart retries", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "launch failed",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });

    await provisionWorkspace(db, ws.id, () => {}, {
      runner: fakeGit,
      startSession: async () => {
        throw new Error("agent not logged in");
      },
    });

    const detail = await getWorkspace(db, ws.id);
    // The workspace provisioned fine and stays usable; only the launch failed.
    expect(detail?.status).toBe("active");
    expect(detail?.pendingIssuePrompt).toBe("implement the ticket");

    // Which is exactly what the startup sweep picks up.
    const started: string[] = [];
    await resumeKickOffs(db, {
      startSession: async (input: StartClaudeSessionInput) => {
        started.push(input.workspaceId);
        return { sessionKey: `ws-claude:${input.workspaceId}` };
      },
      runner: fakeGit,
    });
    expect(started).toEqual([ws.id]);
    expect((await getWorkspace(db, ws.id))?.pendingIssuePrompt).toBeNull();
  });

  it("does not launch a session for a workspace with no ticket", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, { name: "no ticket here", repoIds: [repo.id] });

    const started: StartClaudeSessionInput[] = [];
    await provisionWorkspace(db, ws.id, () => {}, {
      runner: fakeGit,
      startSession: async (input) => {
        started.push(input);
        return { sessionKey: "unused" };
      },
    });

    expect(started).toEqual([]);
  });
});

/**
 * The pending prompt is the sole record of an *unfinished* kick-off, so what it
 * must never do is outlive one. These pin the two places a copy could linger.
 */
describe("pending kick-off prompt retention", () => {
  it("keeps it out of the workspace list, which is polled for every workspace", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    await createWorkspace(db, config, {
      name: "listed",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });

    const res = await app.request("/api/workspaces", { headers: auth });
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("pendingIssuePrompt");
    // Nor does the detail route — it is the sidecar's own bookkeeping.
    const one = await app.request(`/api/workspaces/${(rows[0] as { id: string }).id}`, {
      headers: auth,
    });
    expect(await one.json()).not.toHaveProperty("pendingIssuePrompt");
    // The projection is explicit, so assert the sidebar's fields survive it.
    expect(rows[0]).toMatchObject({ name: "listed", status: "creating", repoNames: ["widget"] });
    expect(rows[0]).toHaveProperty("archivedAt");
    // The open workspace is where it's wanted, and it's still there.
    expect((await getWorkspace(db, rows[0]!.id as string))?.pendingIssuePrompt).toBe(
      "implement the ticket",
    );
  });

  it("drops it when the workspace is archived, since no session can claim it", async () => {
    const db = getDb(url).db;
    const repo = await addRepo();
    const ws = await createWorkspace(db, config, {
      name: "archived with prompt",
      repoIds: [repo.id],
      issuePrompt: "implement the ticket",
    });
    await provisionWorkspace(db, ws.id, () => {}, { runner: fakeGit });

    const result = await archiveWorkspace(db, ws.id, {}, fakeGit);
    expect(result.status).toBe("archived");
    expect((await getWorkspace(db, ws.id))?.pendingIssuePrompt).toBeNull();
  });

  it("rejects a kick-off prompt too large to be a ticket", async () => {
    // The bound is on the client-supplied field, not on start-work, which
    // composes its prompt from an issue GitHub has already capped.
    const repo = await addRepo();
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "oversized",
        repoIds: [repo.id],
        issuePrompt: "x".repeat(70000),
      }),
    });
    expect(res.status).toBe(400);
  });
});
