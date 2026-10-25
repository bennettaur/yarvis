import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import { fakeClaude, resultLine } from "../agentRuns/testSupport.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { agentRuns, reviewWorkspacePrs, reviewWorkspaces } from "../db/schema.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import { type ReviewGit, reviewGit } from "./git.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { reviewSincePatches, reviewSinceReview } from "./reviewMarks.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import { type PrMeta, type ReviewDeps, reviewPatches } from "./service.ts";
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

describe("code navigation", () => {
  const search = (wsId: string, prId: string, kind: string, query: Record<string, string>) =>
    call("GET", `/${wsId}/prs/${prId}/${kind}?${new URLSearchParams(query)}`);

  it("finds definitions and references at the head commit", async () => {
    const { wsId, prId } = await readyWorkspace();
    const { headSha } = await prRow(prId);

    const defs = await search(wsId, prId, "definitions", {
      path: "src/new.ts",
      symbol: "b",
      line: "1",
    });
    expect(defs.status).toBe(200);
    expect(await defs.json()).toEqual({
      headSha,
      truncated: false,
      matches: [{ path: "src/a.ts", line: 2, column: 14, preview: "export const b = 3;" }],
    });

    const refs = await search(wsId, prId, "references", { path: "src/a.ts", symbol: "a" });
    expect(((await refs.json()) as { matches: unknown[] }).matches).toEqual([
      { path: "src/a.ts", line: 1, column: 14, preview: "export const a = 2;" },
    ]);
  });

  it("refuses a symbol that isn't an identifier, and a path that climbs", async () => {
    const { wsId, prId } = await readyWorkspace();
    for (const symbol of ["", "a-b", "--open-files-in-pager=sh", "a b", "a.b", "x*"]) {
      const res = await search(wsId, prId, "definitions", { path: "src/a.ts", symbol });
      expect({ symbol, status: res.status }).toEqual({ symbol, status: 400 });
    }
    for (const path of ["../outside.ts", "/etc/passwd", "src/../../x.ts", "src//a.ts", ""]) {
      const res = await search(wsId, prId, "references", { path, symbol: "a" });
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
    }
    const badLine = await search(wsId, prId, "definitions", {
      path: "src/a.ts",
      symbol: "a",
      line: "x",
    });
    expect(badLine.status).toBe(400);
  });

  it("waits for the checkout, which is what puts every head blob on disk", async () => {
    checkoutGate = gate();
    const { wsId, prId } = await startWorkspace();
    await until(async () => (await prRow(prId)).status === "ready", "ready");
    const res = await search(wsId, prId, "definitions", { path: "src/a.ts", symbol: "a" });
    expect(res.status).toBe(409);
    checkoutGate.open();
    await progress(wsId, prId);
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
      sandboxNotes: expect.stringContaining("setup script runs without a sandbox"),
      consent: null,
      consentHeadSha: null,
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

    expect((await prRow(prId)).setupHeadSha).toBe(headSha);

    const declined = await setup(wsId, prId, { grant: false });
    expect(await declined.json()).toMatchObject({
      setupConsent: "declined",
      setupHeadSha: headSha,
    });
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

describe("verification report", () => {
  const pass = { status: "pass", findings: [] };
  const at = (title: string, line: number) => ({
    title,
    detail: "d",
    severity: "medium",
    path: "src/a.ts",
    line,
  });
  const report = {
    summary: `${"word ".repeat(200)}end.`,
    mustRead: [
      { path: "src/a.ts", reason: "the change" },
      { path: "src/elsewhere.ts", reason: "not changed by the PR" },
    ],
    risk: { level: "low", clientImpact: "None: internal only.", mitigations: [], concerns: [] },
    // The same problem from two checks: the server keeps the specialist's (tests).
    completeness: { status: "issues", findings: [at("b is never read", 2)] },
    tests: { status: "issues", findings: [at("b is never read, and untested", 2)] },
    complexity: pass,
    performance: pass,
    comments: pass,
  };
  let budget: number;
  const detail = {
    title: "Feature work",
    body: "Changes a and renames old.",
    author: "octocat",
    headRef: "feature",
    baseRef: "main",
    checks: [],
    reviewThreads: [],
  } as unknown as PrDetail;

  let fakeDir: string;
  let registry: RunRegistry<AgentRunEvent>;
  let verificationApp: Hono;

  /**
   * A `claude` that records its stdin and argv, waits for `release`, then
   * ends the run with the report as its structured output.
   */
  function setUpFake() {
    fakeDir = mkdtempSync(join(tmpdir(), "yarvis-verification-fake-"));
    writeFileSync(
      join(fakeDir, "result.jsonl"),
      `${JSON.stringify(resultLine({ structured_output: report }))}\n`,
    );
    const program = fakeClaude(
      fakeDir,
      "claude",
      `cat > "${fakeDir}/stdin.txt"
printf '%s\\n' "$@" > "${fakeDir}/args.txt"
while [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
cat "${fakeDir}/result.jsonl"`,
    );
    registry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
    verificationApp = new Hono().route(
      "/rw",
      createReviewWorkspaceRoutes(config, {
        deps,
        verification: {
          loadDetail: async () => detail,
          settings: async () => ({ model: "haiku", maxBudgetUsd: budget }),
          run: { program, registry, instance: "test" },
        },
      }),
    );
  }

  const release = () => writeFileSync(join(fakeDir, "release"), "");

  async function verify(method: string, wsId: string, prId: string): Promise<Response> {
    return verificationApp.request(`/rw/${wsId}/prs/${prId}/verification`, { method });
  }

  async function latest(wsId: string, prId: string) {
    return (await (await verify("GET", wsId, prId)).json()) as {
      run: {
        id: string;
        status: string;
        targetKey: string;
        live: boolean;
        result: typeof report;
      } | null;
      current: boolean;
      headSha: string;
      size: { files: number; changedLines: number; large: boolean } | null;
    };
  }

  /** A run row as another run, kind or PR would have left it. */
  async function insertRun(
    kind: string,
    refKey: string,
    headSha: string,
    minutesAgo: number,
    status = "succeeded",
  ) {
    const [row] = await db
      .insert(agentRuns)
      .values({
        kind,
        targetKey: `${refKey}@${headSha}`,
        status,
        instance: "test",
        meta: { refKey, headSha },
        startedAt: new Date(Date.now() - minutesAgo * 60_000),
      })
      .returning({ id: agentRuns.id });
    return row?.id as string;
  }

  const contextDirs = () =>
    new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("yarvis-verification-")));

  beforeEach(async () => {
    await sql`TRUNCATE agent_runs`;
    budget = 0.5;
    setUpFake();
  });

  afterEach(() => {
    release();
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it("refuses to start before the checkout is ready", async () => {
    checkoutGate = gate();
    const { wsId, prId } = await startWorkspace();
    await until(async () => (await prRow(prId)).status === "ready", "ready");
    const res = await verify("POST", wsId, prId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("checking-out");
  });

  it("starts one run for concurrent requests, and serves it against the current head", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    expect(await latest(wsId, prId)).toMatchObject({ run: null, current: false });

    const responses = await Promise.all([verify("POST", wsId, prId), verify("POST", wsId, prId)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      runId: string;
      existing: boolean;
    }[];
    const runId = bodies[0]?.runId as string;
    expect(bodies[1]?.runId).toBe(runId);
    expect(bodies.map((b) => b.existing).sort()).toEqual([false, true]);
    expect(await db.select().from(agentRuns)).toHaveLength(1);

    // While it runs: the checkout is the working directory, the prepared
    // context is readable, and the settings chose the model and budget.
    await until(async () => existsSync(join(fakeDir, "args.txt")), "the fake's argv");
    const args = readFileSync(join(fakeDir, "args.txt"), "utf8").split("\n");
    const contextDir = args[args.indexOf("--add-dir") + 1] as string;
    expect(readFileSync(join(contextDir, "pr.md"), "utf8")).toContain("Changes a and renames old.");
    expect(readFileSync(join(contextDir, "changes.diff"), "utf8")).toContain(
      "diff --git a/src/a.ts",
    );
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("0.5");
    expect(
      args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools")),
    ).toEqual(["Read", "Grep", "Glob", "Agent", "Skill"]);
    await until(async () => existsSync(join(fakeDir, "stdin.txt")), "the fake's stdin");
    const prompt = readFileSync(join(fakeDir, "stdin.txt"), "utf8");
    expect(prompt).toContain(`REVIEW_CONTEXT=${contextDir}`);
    // The orchestrator's prompt carries no PR text; the agents read it from pr.md.
    expect(prompt).not.toContain("Changes a and renames old.");

    const running = await latest(wsId, prId);
    const headSha = sh(worktreePath, "rev-parse", "HEAD").trim();
    expect(running).toMatchObject({
      run: { id: runId, status: "running", live: true },
      current: true,
      size: { large: false },
    });
    expect(running.run?.targetKey).toBe(`gh:o/r/1@${headSha}`);

    release();
    await until(async () => (await latest(wsId, prId)).run?.status === "succeeded", "the run");
    const done = await latest(wsId, prId);
    expect(done.run?.live).toBe(false);
    // Held to the word cap the diff size gives (the floor, for this small PR).
    expect(done.run?.result.summary).toBe(`${"word ".repeat(10).trim()}…`);
    expect(done.run?.result.mustRead).toEqual([{ path: "src/a.ts", reason: "the change" }]);
    expect(done.run?.result.tests.findings).toHaveLength(1);
    expect(done.run?.result.completeness).toEqual({ status: "pass", findings: [] });
    await until(async () => !existsSync(contextDir), "the context folder to go");

    // What the server took out is on the run, to be audited.
    await until(async () => {
      const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
      const meta = (row?.meta ?? {}) as { droppedDuplicates?: unknown };
      return Array.isArray(meta.droppedDuplicates);
    }, "the audit");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(row?.meta).toMatchObject({
      refKey: "gh:o/r/1",
      headSha,
      droppedMustReads: ["src/elsewhere.ts"],
      droppedDuplicates: [
        {
          section: "completeness",
          keptIn: "tests",
          title: "b is never read",
          path: "src/a.ts",
        },
      ],
    });

    // A push moves the PR on; the old report is still served, marked stale.
    remote.pushToPr("src/a.ts", "export const a = 5;\n");
    await call("POST", `/${wsId}/prs/${prId}/refresh`);
    await progress(wsId, prId);
    expect(await latest(wsId, prId)).toMatchObject({ run: { id: runId }, current: false });
  });

  it("serves the PR's newest run, ignoring other kinds and other PRs", async () => {
    const { wsId, prId } = await readyWorkspace();
    const headSha = (await prRow(prId)).headSha as string;
    await insertRun("verification-report", "gh:o/r/1", "old", 30);
    const newest = await insertRun("verification-report", "gh:o/r/1", headSha, 20);
    await insertRun("mutation-testing", "gh:o/r/1", headSha, 10);
    // A key `gh:o/r/1` is a prefix of; a prefix match would pick it.
    await insertRun("verification-report", "gh:o/r/10", headSha, 5);

    expect(await latest(wsId, prId)).toMatchObject({
      run: { id: newest, live: false },
      current: true,
      lastSucceeded: { run: { id: newest }, headSha, current: true },
    });
  });

  it("keeps the last good report in view when a re-run fails", async () => {
    const { wsId, prId } = await readyWorkspace();
    const headSha = (await prRow(prId)).headSha as string;
    const good = await insertRun("verification-report", "gh:o/r/1", "older-head", 30);
    const failed = await insertRun("verification-report", "gh:o/r/1", headSha, 5, "failed");

    expect(await latest(wsId, prId)).toMatchObject({
      run: { id: failed, status: "failed" },
      current: true,
      lastSucceeded: { run: { id: good }, headSha: "older-head", current: false },
    });
  });

  it("removes the context folder and records nothing when the run can't start", async () => {
    const { wsId, prId } = await readyWorkspace();
    budget = 0;
    const before = contextDirs();
    const res = await verify("POST", wsId, prId);
    expect(res.status).toBe(500);
    expect(contextDirs()).toEqual(before);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });
});

describe("re-review summary", () => {
  const answer = {
    summary: "Changed a. Nothing else.",
    verdict: "ready_to_approve",
    verdictReason: "All addressed.",
    comments: [
      {
        threadId: "T1",
        verdict: "addressed",
        evidence: { path: "src/a.ts", line: 1, note: "a is 5 now." },
      },
    ],
    newChanges: [],
  };
  let viewer: string;
  let detailFails: boolean;
  const detail = (): PrDetail =>
    ({
      title: "Feature work",
      body: "Changes a.",
      author: "octocat",
      reviewThreads: [
        {
          id: "PRRT_mine",
          path: "src/a.ts",
          line: 1,
          side: "RIGHT",
          isResolved: false,
          isOutdated: false,
          canReply: true,
          canResolve: true,
          canUnresolve: true,
          comments: [
            { id: "c1", author: "me", body: "Make a 5.", createdAt: "2026-10-01T00:00:00Z" },
          ],
        },
        {
          id: "PRRT_theirs",
          path: "src/a.ts",
          line: 2,
          side: "RIGHT",
          isResolved: false,
          isOutdated: false,
          canReply: true,
          canResolve: true,
          canUnresolve: true,
          comments: [
            { id: "c2", author: "bob", body: "Rename b.", createdAt: "2026-10-01T00:00:00Z" },
          ],
        },
      ],
      conversation: [],
    }) as unknown as PrDetail;

  let fakeDir: string;
  let registry: RunRegistry<AgentRunEvent>;
  let rereviewApp: Hono;

  function setUpFake() {
    fakeDir = mkdtempSync(join(tmpdir(), "yarvis-rereview-fake-"));
    writeFileSync(
      join(fakeDir, "result.jsonl"),
      `${JSON.stringify(resultLine({ structured_output: answer }))}\n`,
    );
    const program = fakeClaude(
      fakeDir,
      "claude",
      `cat > "${fakeDir}/stdin.txt"
printf '%s\\n' "$@" > "${fakeDir}/args.txt"
while [ ! -f "${fakeDir}/release" ]; do sleep 0.02; done
cat "${fakeDir}/result.jsonl"`,
    );
    registry = new RunRegistry<AgentRunEvent>({ historyCap: 500, followerQueueCap: 2_000 });
    rereviewApp = new Hono().route(
      "/rw",
      createReviewWorkspaceRoutes(config, {
        deps,
        rereview: {
          loadDetail: async () => {
            if (detailFails) throw new Error("provider is down");
            return detail();
          },
          viewer: async () => ({ login: viewer }),
          settings: async () => ({ model: "haiku", maxBudgetUsd: 0.5, autoStart: false }),
          run: { program, registry, instance: "test" },
        },
      }),
    );
  }

  const release = () => writeFileSync(join(fakeDir, "release"), "");

  async function rereview(method: string, wsId: string, prId: string, from?: string) {
    return rereviewApp.request(`/rw/${wsId}/prs/${prId}/rereview${from ? `?from=${from}` : ""}`, {
      method,
    });
  }

  type Latest = {
    run: {
      id: string;
      status: string;
      targetKey: string;
      fromHeadSha: string;
      toHeadSha: string;
      result: { verdict: string; comments: { threadId: string; providerId: string }[] } | null;
    } | null;
    fromHeadSha: string | null;
    headSha: string;
    current: boolean;
    lastSucceeded: { run: { id: string }; current: boolean } | null;
  };
  async function latest(wsId: string, prId: string, from?: string): Promise<Latest> {
    return (await (await rereview("GET", wsId, prId, from)).json()) as Latest;
  }

  /** A PR reviewed at its first head and pushed to since. */
  async function reviewedThenPushed() {
    const ready = await readyWorkspace();
    const reviewed = (await prRow(ready.prId)).headSha as string;
    expect((await call("POST", `/${ready.wsId}/prs/${ready.prId}/review-mark`)).status).toBe(201);
    remote.pushToPr("src/a.ts", "export const a = 5;\n");
    await call("POST", `/${ready.wsId}/prs/${ready.prId}/refresh`);
    await progress(ready.wsId, ready.prId);
    const head = (await prRow(ready.prId)).headSha as string;
    return { ...ready, reviewed, head };
  }

  beforeEach(async () => {
    await sql`TRUNCATE agent_runs, pr_review_marks`;
    viewer = "me";
    detailFails = false;
    setUpFake();
  });

  afterEach(() => {
    release();
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it("starts one run per range, judging only the viewer's comments", async () => {
    const { wsId, prId, reviewed, head } = await reviewedThenPushed();
    expect(await latest(wsId, prId)).toMatchObject({
      run: null,
      fromHeadSha: reviewed,
      headSha: head,
      current: false,
    });

    const responses = await Promise.all([
      rereview("POST", wsId, prId),
      rereview("POST", wsId, prId),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 202]);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
      runId: string;
      existing: boolean;
      fromHeadSha: string;
      toHeadSha: string;
    }[];
    expect(bodies[0]?.runId).toBe(bodies[1]?.runId as string);
    expect(bodies[0]).toMatchObject({ fromHeadSha: reviewed, toHeadSha: head });
    expect(await db.select().from(agentRuns)).toHaveLength(1);

    // The run is the rereviewer agent, reading the prepared context.
    await until(async () => existsSync(join(fakeDir, "args.txt")), "the fake's argv");
    const args = readFileSync(join(fakeDir, "args.txt"), "utf8").split("\n");
    expect(args[args.indexOf("--agent") + 1]).toBe("yarvis-review:rereviewer");
    expect(
      args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools")),
    ).toEqual(["Read", "Grep", "Glob"]);
    const contextDir = args[args.indexOf("--add-dir") + 1] as string;
    const context = readFileSync(join(contextDir, "rereview.md"), "utf8");
    expect(context).toContain("Make a 5.");
    expect(context).not.toContain("Rename b.");
    expect(readFileSync(join(contextDir, "interdiff.diff"), "utf8")).toContain(
      "diff --git a/src/a.ts b/src/a.ts",
    );
    await until(async () => existsSync(join(fakeDir, "stdin.txt")), "the fake's stdin");
    expect(readFileSync(join(fakeDir, "stdin.txt"), "utf8")).toContain("COMMENT_IDS=T1\n");

    const running = await latest(wsId, prId);
    expect(running).toMatchObject({ run: { status: "running" }, current: true });
    expect(running.run?.targetKey).toBe(`gh:o/r/1@${reviewed}..${head}`);

    release();
    await until(async () => (await latest(wsId, prId)).run?.status === "succeeded", "the run");
    const done = await latest(wsId, prId);
    expect(done.run?.result?.verdict).toBe("ready_to_approve");
    expect(done.run?.result?.comments).toMatchObject([{ threadId: "T1", providerId: "PRRT_mine" }]);
    expect(done.lastSucceeded).toMatchObject({ run: { id: done.run?.id }, current: true });
    await until(async () => !existsSync(contextDir), "the context folder to go");

    // From another review head, the same run doesn't cover the range.
    expect(await latest(wsId, prId, head)).toMatchObject({ current: false });
  });

  it("keeps the last good summary in view when a re-run fails", async () => {
    const { wsId, prId, reviewed, head } = await reviewedThenPushed();
    const insert = async (status: string, minutesAgo: number, from: string) => {
      const [row] = await db
        .insert(agentRuns)
        .values({
          kind: "pr-rereview",
          targetKey: `gh:o/r/1@${from}..${head}`,
          status,
          instance: "test",
          meta: { refKey: "gh:o/r/1", fromHeadSha: from, toHeadSha: head },
          startedAt: new Date(Date.now() - minutesAgo * 60_000),
        })
        .returning({ id: agentRuns.id });
      return row?.id as string;
    };
    const good = await insert("succeeded", 30, reviewed);
    const failed = await insert("failed", 5, reviewed);
    // A verification run for the same PR is another kind.
    await db.insert(agentRuns).values({
      kind: "verification-report",
      targetKey: `gh:o/r/1@${head}`,
      status: "succeeded",
      instance: "test",
      meta: { refKey: "gh:o/r/1", headSha: head },
    });
    expect(await latest(wsId, prId)).toMatchObject({
      run: { id: failed, status: "failed", fromHeadSha: reviewed, toHeadSha: head },
      current: true,
      lastSucceeded: { run: { id: good }, current: true },
    });
  });

  it("refuses what it can't judge, starting nothing", async () => {
    const { wsId, prId, reviewed, head } = await reviewedThenPushed();
    expect((await rereview("POST", wsId, prId, "not-a-sha")).status).toBe(400);
    // Only a commit a review was recorded at.
    expect((await rereview("POST", wsId, prId, head)).status).toBe(400);
    detailFails = true;
    const res = await rereview("POST", wsId, prId);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("provider is down");
    detailFails = false;
    viewer = "";
    const nobody = await rereview("POST", wsId, prId, reviewed);
    expect(nobody.status).toBe(502);
    expect(((await nobody.json()) as { error: string }).error).toContain("who you are");
    // Nothing changed since a review at the head.
    viewer = "me";
    expect((await call("POST", `/${wsId}/prs/${prId}/review-mark`)).status).toBe(201);
    expect((await rereview("POST", wsId, prId)).status).toBe(409);
    expect(await db.select().from(agentRuns)).toHaveLength(0);
  });

  it("reads each changed file's interdiff within the budgets, and the new commits' messages", async () => {
    const { wsId, prId } = await reviewedThenPushed();
    remote.pushToPr("src/b.ts", `${"export const big = 1;\n".repeat(200)}`);
    sh(remote.work, "checkout", "-q", "feature");
    writeFileSync(join(remote.work, "src/c.ts"), "export const c = 1;\n");
    sh(remote.work, "add", "-A");
    sh(remote.work, "commit", "-q", "-m", "Add c\n\nBecause the cache needs it.");
    sh(remote.work, "push", "-q", remote.bare, "feature:refs/pull/1/head", "--force");
    sh(remote.work, "checkout", "-q", "main");
    await call("POST", `/${wsId}/prs/${prId}/refresh`);
    await progress(wsId, prId);

    const since = await reviewSinceReview(db, config, wsId, prId, deps());
    const read = (maxTotalBytes: number) =>
      reviewSincePatches(db, config, wsId, prId, deps(), since, {
        maxFileBytes: 2_000,
        maxTotalBytes,
      });
    const size = (path: string, all: Awaited<ReturnType<typeof read>>) =>
      all.patches.find((p) => p.file.path === path)?.patch?.length ?? 0;
    const unbounded = await read(1_000_000);
    const { patches, messages } = await read(
      size("src/a.ts", unbounded) + size("src/c.ts", unbounded) - 1,
    );
    const byPath = Object.fromEntries(patches.map((p) => [p.file.path, p]));
    expect(byPath["src/b.ts"]).toMatchObject({ patch: null, omitted: "too-large" });
    expect(byPath["src/a.ts"]?.patch).toContain("+export const a = 5;");
    // a.ts fits first (path order); c.ts would take the total past the budget.
    expect(byPath["src/c.ts"]).toMatchObject({ patch: null, omitted: "over-budget" });
    expect(byPath["src/c.ts"]?.file.additions).toBe(1);
    const fresh = since.commits.filter((c) => c.isNew);
    expect(fresh).toHaveLength(3);
    const added = fresh.find((c) => c.subject === "Add c");
    expect(messages.get(added?.sha as string)).toBe("Add c\n\nBecause the cache needs it.");
    expect(messages.size).toBe(3);
  });
});

describe("patches for an agent run", () => {
  it("leaves out binary, oversized and over-budget files, in path order", async () => {
    const { prId } = await readyWorkspace();
    const row = await prRow(prId);
    const all = await reviewPatches(config, row, deps(), {
      maxFileBytes: 4096,
      maxTotalBytes: 1_000_000,
    });
    const paths = all.patches.map((p) => p.file.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    const omitted = Object.fromEntries(all.patches.map((p) => [p.file.path, p.omitted]));
    expect(omitted).toMatchObject({
      "image.bin": "binary",
      "big.txt": "too-large",
      "huge.txt": "too-large",
      "src/a.ts": null,
    });
    expect(all.headSha).toBe(row.headSha as string);

    // Room for the first included patch only: the rest are listed, not read.
    const first = all.patches.find((p) => p.patch !== null);
    if (!first?.patch) throw new Error("no patch was included");
    const tight = await reviewPatches(config, row, deps(), {
      maxFileBytes: 4096,
      maxTotalBytes: first.patch.length,
    });
    const included = tight.patches.filter((p) => p.patch !== null).map((p) => p.file.path);
    expect(included).toEqual([first.file.path]);
    expect(tight.patches.find((p) => p.file.path === "src/a.ts")?.omitted).toBe("over-budget");
  });
});
