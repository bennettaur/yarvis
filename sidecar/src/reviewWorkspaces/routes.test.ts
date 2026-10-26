import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { reviewWorkspacePrs, reviewWorkspaces } from "../db/schema.ts";
import type { PrRef } from "../pr/types.ts";
import { type ReviewGit, reviewGit } from "./git.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { PrMeta, ReviewDeps } from "./service.ts";
import { createTestRemote, sh, type TestRemote } from "./testRepo.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};

/** A gate a fake dependency waits on until the test opens it. */
function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

// Per-test state the fake dependencies read.
let remote: TestRemote;
let meta: PrMeta;
let setupScript: string | null;
let loadFails: boolean;
let checkoutFails: boolean;
let loadGate: ReturnType<typeof gate> | null;
let checkoutGate: ReturnType<typeof gate> | null;

/** Real git against the local test remote, with the checkout under the test's control. */
function controlledGit(): ReviewGit {
  const inner = reviewGit({ allowFileProtocol: true });
  return {
    ...inner,
    local: async (args, opts) => {
      if (args[0] === "checkout") {
        if (checkoutFails) return { stdout: "", stderr: "checkout exploded", exitCode: 1 };
        await checkoutGate?.promise;
      }
      return inner.local(args, opts);
    },
  };
}

/** The provider is faked; git is real. */
const deps = (): ReviewDeps => ({
  loadPr: async () => {
    await loadGate?.promise;
    if (loadFails) throw new Error("provider is down");
    return meta;
  },
  remoteUrlFor: async () => remote.url,
  credentialsFor: () => undefined,
  setupScriptFor: async () => setupScript,
  git: controlledGit,
});

const app = new Hono().route("/rw", createReviewWorkspaceRoutes(config, { deps }));
const db = getDb(url).db;
const json = { "Content-Type": "application/json" };
const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/rw${path === "/" ? "" : path}`, {
    method,
    headers: body === undefined ? undefined : json,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Reads a progress stream to its end. */
async function progress(wsId: string, prId: string): Promise<ReviewProgressEvent[]> {
  const res = await call("GET", `/${wsId}/prs/${prId}/progress`);
  const text = await res.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ReviewProgressEvent);
}

async function prRow(prId: string) {
  const [row] = await db.select().from(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, prId));
  if (!row) throw new Error("no row");
  return row;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Creates a workspace holding `pr` and starts its clone, without waiting. */
async function startWorkspace(pr: PrRef = ref): Promise<{ wsId: string; prId: string }> {
  const res = await call("POST", "/", { name: "Review", refs: [pr] });
  expect(res.status).toBe(201);
  const ws = (await res.json()) as { id: string; prs: { id: string }[] };
  return { wsId: ws.id, prId: ws.prs[0]?.id as string };
}

async function readyWorkspace(
  pr: PrRef = ref,
): Promise<{ wsId: string; prId: string; worktreePath: string }> {
  const { wsId, prId } = await startWorkspace(pr);
  const events = await progress(wsId, prId);
  expect(events.at(-1)).toMatchObject({ type: "done", status: "ready", error: null });
  return { wsId, prId, worktreePath: (await prRow(prId)).worktreePath };
}

async function setup(wsId: string, prId: string, answer: Record<string, unknown>) {
  return call("POST", `/${wsId}/prs/${prId}/setup`, answer);
}

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs RESTART IDENTITY CASCADE`;
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-review-root-"));
  remote = createTestRemote();
  meta = {
    title: "Feature work",
    author: "octocat",
    headRef: "feature",
    baseRef: "main",
    fromFork: true,
  };
  setupScript = null;
  loadFails = false;
  checkoutFails = false;
  loadGate = null;
  checkoutGate = null;
});

afterEach(() => {
  // Open anything a failed test left shut, so its background run can end.
  loadGate?.open();
  checkoutGate?.open();
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

describe("reads", () => {
  it("clones a PR and serves changed files, tree, files and diffs with their shas", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    expect(worktreePath).toBe(join(config.workspacesRoot, ".review", wsId, "gh-o-r-1"));
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(true);
    expect(existsSync(join(config.workspacesRoot, ".review-repos/github/o/r/.git"))).toBe(true);

    const row = await prRow(prId);
    expect(row).toMatchObject({
      status: "ready",
      worktreeStatus: "ready",
      title: "Feature work",
      colorIndex: 0,
    });
    const { headSha, mergeBaseSha } = row;

    const changed = (await (await call("GET", `/${wsId}/prs/${prId}/changed-files`)).json()) as {
      headSha: string;
      mergeBaseSha: string;
      files: { path: string }[];
    };
    expect(changed).toMatchObject({ headSha, mergeBaseSha });
    expect(changed.files.map((f) => f.path)).toEqual([
      "big.txt",
      "docs/gone.md",
      "huge.txt",
      "image.bin",
      "latin1.txt",
      "src/a.ts",
      "src/new.ts",
    ]);
    // Sizes are for checking diffs against the cap, not part of the response.
    expect(changed.files[0]).not.toHaveProperty("newSize");

    const tree = (await (await call("GET", `/${wsId}/prs/${prId}/tree`)).json()) as {
      headSha: string;
      paths: string[];
    };
    expect(tree.headSha).toBe(headSha as string);
    expect(tree.paths).toContain("README.md");
    expect(tree.paths).not.toContain("later.md");

    const head = await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts&side=head`);
    expect(await head.json()).toMatchObject({
      content: "export const a = 2;\nexport const b = 3;\n",
      sha: headSha,
    });
    const base = await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts&side=base`);
    expect(await base.json()).toMatchObject({
      content: "export const a = 1;\n",
      sha: mergeBaseSha,
    });

    const diff = await call("GET", `/${wsId}/prs/${prId}/diff?path=src/new.ts`);
    const body = (await diff.json()) as { patch: string };
    expect(body).toMatchObject({ oldPath: "src/old.ts", tooLarge: false, headSha, mergeBaseSha });
    expect(body.patch).toContain("rename from src/old.ts");
  });

  it("refuses to diff a file over the size cap", async () => {
    const { wsId, prId } = await readyWorkspace();
    const res = await call("GET", `/${wsId}/prs/${prId}/diff?path=huge.txt`);
    expect(await res.json()).toMatchObject({ path: "huge.txt", patch: "", tooLarge: true });
  });

  it("refuses traversal, unknown paths and bad ids", async () => {
    const { wsId, prId } = await readyWorkspace();
    for (const path of ["../../etc/passwd", "/etc/passwd", "a/../b", ""]) {
      const res = await call("GET", `/${wsId}/prs/${prId}/file?path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(400);
    }
    expect((await call("GET", `/${wsId}/prs/${prId}/file?path=nope.txt`)).status).toBe(404);
    expect(
      (await call("GET", `/${wsId}/prs/${prId}/file?path=docs/gone.md&side=head`)).status,
    ).toBe(404);
    expect((await call("GET", `/${wsId}/prs/${prId}/diff?path=nope.txt`)).status).toBe(404);
    // In the tree but not changed by the PR.
    expect((await call("GET", `/${wsId}/prs/${prId}/diff?path=README.md`)).status).toBe(404);
    expect((await call("GET", `/${wsId}/prs/${prId}/diff?path=../x`)).status).toBe(400);
    expect((await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts&side=x`)).status).toBe(400);
    expect((await call("GET", `/not-a-uuid`)).status).toBe(400);
    expect((await call("GET", `/${wsId}/prs/not-a-uuid/tree`)).status).toBe(400);
  });

  it("validates refs, and refuses a duplicate PR", async () => {
    const bad = await call("POST", "/", {
      name: "x",
      refs: [{ provider: "github", owner: "..", repo: "r", number: 1 }],
    });
    expect(bad.status).toBe(400);
    const { wsId } = await readyWorkspace();
    expect((await call("POST", `/${wsId}/prs`, { ref })).status).toBe(409);
  });

  it("reviews an Azure PR, cloned into a four-segment folder", async () => {
    const azure: PrRef = {
      provider: "azure",
      org: "Org",
      project: "My Project",
      repo: "r",
      prId: 2,
    };
    const { wsId, prId, worktreePath } = await readyWorkspace(azure);
    expect(
      existsSync(join(config.workspacesRoot, ".review-repos/azure/org/my project/r/.git")),
    ).toBe(true);
    expect(worktreePath).toBe(
      join(config.workspacesRoot, ".review", wsId, "az-Org-My-Project-r-2"),
    );
    // The merge preview's second parent is the PR head.
    expect((await prRow(prId)).headSha).toBe(sh(remote.work, "rev-parse", "feature").trim());
  });
});

describe("ready before checkout", () => {
  it("serves reads while the checkout runs, and holds setup until it is done", async () => {
    checkoutGate = gate();
    setupScript = "true";
    const { wsId, prId } = await startWorkspace();
    await until(async () => (await prRow(prId)).status === "ready", "ready");
    const row = await prRow(prId);
    expect(row.worktreeStatus).toBe("checking-out");

    const changed = await call("GET", `/${wsId}/prs/${prId}/changed-files`);
    expect(changed.status).toBe(200);
    const file = await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts`);
    expect(await file.json()).toMatchObject({
      content: "export const a = 2;\nexport const b = 3;\n",
    });
    const grant = await setup(wsId, prId, { grant: true, script: "true", headSha: row.headSha });
    expect(grant.status).toBe(409);

    checkoutGate.open();
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ready", error: null });
    expect((await prRow(prId)).worktreeStatus).toBe("ready");
  });

  it("leaves the PR reviewable when the checkout fails", async () => {
    checkoutFails = true;
    const { wsId, prId } = await startWorkspace();
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ready" });
    expect((events.at(-1) as { error: string }).error).toContain("checkout exploded");
    expect(await prRow(prId)).toMatchObject({ status: "ready", worktreeStatus: "error" });
    expect((await call("GET", `/${wsId}/prs/${prId}/changed-files`)).status).toBe(200);
  });
});

describe("refresh", () => {
  it("moves to the new head, and reads answer from it rather than the cache", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    const before = await (await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts`)).json();
    expect(before).toMatchObject({ content: "export const a = 2;\nexport const b = 3;\n" });

    const newHead = remote.pushToPr("src/a.ts", "export const a = 4;\n");
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
    const events = await progress(wsId, prId);
    expect(events[0]).toEqual({ type: "start", phase: "refresh" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ready" });
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(newHead);

    const after = await (await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts`)).json();
    expect(after).toMatchObject({ content: "export const a = 4;\n", sha: newHead });
    const changed = (await (await call("GET", `/${wsId}/prs/${prId}/changed-files`)).json()) as {
      headSha: string;
    };
    expect(changed.headSha).toBe(newHead);
  });

  it("keeps serving the old head when a refresh fails", async () => {
    const { wsId, prId } = await readyWorkspace();
    const oldHead = (await prRow(prId)).headSha;
    loadFails = true;
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      phase: "refresh",
      status: "ready",
      error: "provider is down",
    });
    expect(await prRow(prId)).toMatchObject({
      status: "ready",
      headSha: oldHead,
      error: "provider is down",
    });
    expect((await call("GET", `/${wsId}/prs/${prId}/file?path=src/a.ts`)).status).toBe(200);
  });

  it("refuses a second refresh while one is running", async () => {
    const { wsId, prId } = await readyWorkspace();
    loadGate = gate();
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(409);
    loadGate.open();
    await progress(wsId, prId);
  });

  it("runs a refresh of a PR whose clone failed as a clone", async () => {
    loadFails = true;
    const { wsId, prId } = await startWorkspace();
    expect((await progress(wsId, prId)).at(-1)).toMatchObject({ status: "error" });
    expect((await prRow(prId)).status).toBe("error");

    loadFails = false;
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
    const events = await progress(wsId, prId);
    expect(events[0]).toEqual({ type: "start", phase: "clone" });
    expect(events.at(-1)).toMatchObject({ status: "ready", error: null });
  });
});

describe("setup", () => {
  it("shows the script, author, branch, commit and withheld environment", async () => {
    const { wsId, prId } = await readyWorkspace();
    setupScript = "echo hello > setup-ran.txt";
    const info = await (await call("GET", `/${wsId}/prs/${prId}/setup`)).json();
    expect(info).toEqual({
      script: "echo hello > setup-ran.txt",
      author: "octocat",
      branch: "feature",
      headSha: (await prRow(prId)).headSha,
      withheldEnv: ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_SSH", "GIT_SSH_COMMAND"],
      consent: null,
      status: null,
      log: null,
    });
  });

  it("runs only the script and commit that were shown", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    const { headSha } = await prRow(prId);
    setupScript = "echo hello > setup-ran.txt";

    const staleScript = await setup(wsId, prId, { grant: true, script: "echo other", headSha });
    expect(staleScript.status).toBe(409);
    const staleHead = await setup(wsId, prId, {
      grant: true,
      script: setupScript,
      headSha: "0".repeat(40),
    });
    expect(staleHead.status).toBe(409);
    expect(existsSync(join(worktreePath, "setup-ran.txt"))).toBe(false);

    expect((await setup(wsId, prId, { grant: true, script: setupScript, headSha })).status).toBe(
      200,
    );
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({ type: "done", phase: "setup", status: "succeeded" });
    expect(readFileSync(join(worktreePath, "setup-ran.txt"), "utf8")).toBe("hello\n");

    const declined = await setup(wsId, prId, { grant: false });
    expect(((await declined.json()) as { setupConsent: string }).setupConsent).toBe("declined");
  });

  it("runs one of two grants made at once", async () => {
    const { wsId, prId } = await readyWorkspace();
    const { headSha } = await prRow(prId);
    setupScript = "sleep 0.3";
    const answer = { grant: true, script: setupScript, headSha };
    const statuses = (
      await Promise.all([setup(wsId, prId, answer), setup(wsId, prId, answer)])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([200, 409]);
    await progress(wsId, prId);
    expect((await prRow(prId)).setupStatus).toBe("succeeded");
  });

  it("refuses a grant while the PR is syncing, leaving nothing marked running", async () => {
    const { wsId, prId } = await readyWorkspace();
    const { headSha } = await prRow(prId);
    setupScript = "true";
    loadGate = gate();
    await call("POST", `/${wsId}/prs/${prId}/refresh`);
    const res = await setup(wsId, prId, { grant: true, script: "true", headSha });
    expect(res.status).toBe(409);
    expect((await prRow(prId)).setupStatus).toBeNull();
    loadGate.open();
    await progress(wsId, prId);
  });

  it("records skipped with no script, and failed with the log tail on a non-zero exit", async () => {
    const { wsId, prId } = await readyWorkspace();
    const { headSha } = await prRow(prId);
    const skipped = await setup(wsId, prId, { grant: true, script: null, headSha });
    expect(((await skipped.json()) as { setupStatus: string }).setupStatus).toBe("skipped");

    setupScript = "echo about to fail; exit 3";
    await setup(wsId, prId, { grant: true, script: setupScript, headSha });
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({
      phase: "setup",
      status: "failed",
      error: "setup script exited 3",
    });
    expect(await prRow(prId)).toMatchObject({ setupStatus: "failed", setupLog: "about to fail\n" });
  });
});

describe("removing and archiving", () => {
  it("removes a PR's worktree and keeps the clone", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    expect((await call("DELETE", `/${wsId}/prs/${prId}`)).status).toBe(200);
    expect(existsSync(worktreePath)).toBe(false);
    expect(existsSync(join(config.workspacesRoot, ".review-repos/github/o/r/.git"))).toBe(true);
  });

  it("refuses to remove a PR that is still syncing", async () => {
    checkoutGate = gate();
    const { wsId, prId } = await startWorkspace();
    await until(async () => (await prRow(prId)).status === "ready", "ready");
    expect((await call("DELETE", `/${wsId}/prs/${prId}`)).status).toBe(409);
    checkoutGate.open();
    await progress(wsId, prId);
  });

  it("deletes nothing outside the workspace folder, whatever the row says", async () => {
    const { wsId, prId } = await readyWorkspace();
    const sibling = join(config.workspacesRoot, ".review", "someone-else");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "keep.txt"), "mine\n");
    await db
      .update(reviewWorkspacePrs)
      .set({ worktreePath: sibling })
      .where(eq(reviewWorkspacePrs.id, prId));
    expect((await call("DELETE", `/${wsId}/prs/${prId}`)).status).toBe(500);
    expect(readFileSync(join(sibling, "keep.txt"), "utf8")).toBe("mine\n");
  });

  it("archives once when asked twice, removing the worktrees and keeping the clone", async () => {
    const { wsId, prId } = await readyWorkspace();
    // A PR that doesn't exist on the remote never gets a worktree; archiving
    // still has to cope with it.
    const added = await call("POST", `/${wsId}/prs`, {
      ref: { provider: "github", owner: "o", repo: "r", number: 3 },
    });
    const failed = (await added.json()) as { id: string; colorIndex: number };
    expect(failed.colorIndex).toBe(1);
    expect((await progress(wsId, failed.id)).at(-1)).toMatchObject({ status: "error" });

    const statuses = (
      await Promise.all([call("POST", `/${wsId}/archive`), call("POST", `/${wsId}/archive`)])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([202, 409]);
    await until(async () => {
      const [row] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, wsId));
      return row?.status === "archived";
    }, "archived");
    expect(existsSync(join(config.workspacesRoot, ".review", wsId))).toBe(false);
    expect(existsSync(join(config.workspacesRoot, ".review-repos/github/o/r/.git"))).toBe(true);
    expect((await prRow(prId)).status).toBe("ready");
    expect(((await (await call("GET", "/")).json()) as unknown[]).length).toBe(0);
    expect((await call("POST", `/${wsId}/prs`, { ref })).status).toBe(409);
  });

  it("archives a workspace whose clone is still running, once it finishes", async () => {
    checkoutGate = gate();
    const { wsId, prId } = await startWorkspace();
    await until(async () => (await prRow(prId)).status === "ready", "ready");
    expect((await call("POST", `/${wsId}/archive`)).status).toBe(202);
    checkoutGate.open();
    await until(async () => {
      const [row] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, wsId));
      return row?.status === "archived";
    }, "archived");
    const [row] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, wsId));
    expect(row?.error).toBeNull();
    expect(existsSync(join(config.workspacesRoot, ".review", wsId))).toBe(false);
  });

  it("doesn't restart a stalled clone in an archived workspace", async () => {
    const [ws] = await db
      .insert(reviewWorkspaces)
      .values({ name: "Old", status: "archived" })
      .returning();
    const [pr] = await db
      .insert(reviewWorkspacePrs)
      .values({
        workspaceId: ws?.id as string,
        refKey: "gh:o/r/1",
        ref,
        colorIndex: 0,
        position: 0,
        status: "cloning",
        worktreePath: join(config.workspacesRoot, ".review", ws?.id as string, "gh-o-r-1"),
      })
      .returning();
    expect(await progress(ws?.id as string, pr?.id as string)).toEqual([]);
    await Bun.sleep(100);
    expect((await prRow(pr?.id as string)).status).toBe("cloning");
    expect(existsSync(join(config.workspacesRoot, ".review", ws?.id as string))).toBe(false);
  });
});
