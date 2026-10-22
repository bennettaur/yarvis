import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { reviewWorkspaces } from "../db/schema.ts";
import type { PrRef } from "../pr/types.ts";
import { reviewGit } from "./git.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { PrMeta, ReviewDeps } from "./service.ts";
import { createTestRemote, sh } from "./testRepo.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-review-root-"));
const remote = createTestRemote();

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

const meta: PrMeta = {
  title: "Feature work",
  author: "octocat",
  headRef: "feature",
  baseRef: "main",
  fromFork: true,
};
let setupScript: string | null = null;

/** The provider is faked; git is real, against the local test remote. */
const deps = (): ReviewDeps => ({
  loadPr: async () => meta,
  remoteFor: async () => ({ url: remote.url, env: {} }),
  setupScriptFor: async () => setupScript,
  git: reviewGit,
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

async function readyWorkspace(): Promise<{ wsId: string; prId: string; worktreePath: string }> {
  const res = await call("POST", "/", { name: "Review", refs: [ref] });
  expect(res.status).toBe(201);
  const ws = (await res.json()) as { id: string; prs: { id: string; worktreePath: string }[] };
  const pr = ws.prs[0]!;
  const events = await progress(ws.id, pr.id);
  expect(events.at(-1)).toMatchObject({ type: "done", status: "ready", error: null });
  return { wsId: ws.id, prId: pr.id, worktreePath: pr.worktreePath };
}

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs RESTART IDENTITY CASCADE`;
  setupScript = null;
});

afterAll(async () => {
  await sql.end();
  rmSync(workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

describe("review workspace routes", () => {
  it("creates a workspace, clones its PR, and serves the review reads", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    expect(worktreePath).toBe(join(workspacesRoot, ".review", wsId, "gh-o-r-1"));
    expect(existsSync(join(worktreePath, "src/new.ts"))).toBe(true);
    expect(existsSync(join(workspacesRoot, ".review-repos/github/o/r/.git"))).toBe(true);

    const detail = (await (await call("GET", `/${wsId}`)).json()) as {
      prs: { headSha: string; mergeBaseSha: string }[];
    };
    expect(detail.prs[0]).toMatchObject({
      status: "ready",
      worktreeStatus: "ready",
      title: "Feature work",
      colorIndex: 0,
    });
    const { headSha, mergeBaseSha } = detail.prs[0]!;

    const changed = (await (await call("GET", `/${wsId}/prs/${prId}/changed-files`)).json()) as {
      headSha: string;
      mergeBaseSha: string;
      files: { path: string }[];
    };
    expect(changed).toMatchObject({ headSha, mergeBaseSha });
    expect(changed.files.map((f) => f.path)).toEqual([
      "big.txt",
      "docs/gone.md",
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
    expect(tree.headSha).toBe(headSha);
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
    const body = (await diff.json()) as { patch: string; oldPath: string; tooLarge: boolean };
    expect(body).toMatchObject({ oldPath: "src/old.ts", tooLarge: false, headSha, mergeBaseSha });
    expect(body.patch).toContain("rename from src/old.ts");
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
    const dup = await call("POST", `/${wsId}/prs`, { ref });
    expect(dup.status).toBe(409);
  });

  it("refreshes to a new head", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    const newHead = remote.pushToPr("src/a.ts", "export const a = 4;\n");
    expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
    const events = await progress(wsId, prId);
    expect(events[0]).toEqual({ type: "start", phase: "refresh" });
    expect(events.at(-1)).toMatchObject({ type: "done", status: "ready" });
    expect(sh(worktreePath, "rev-parse", "HEAD").trim()).toBe(newHead);
  });

  it("asks before running the setup script, and runs only the script that was shown", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    setupScript = "echo hello > setup-ran.txt";

    const info = await (await call("GET", `/${wsId}/prs/${prId}/setup`)).json();
    expect(info).toEqual({
      script: "echo hello > setup-ran.txt",
      author: "octocat",
      branch: "feature",
      consent: null,
      status: null,
      log: null,
    });

    const stale = await call("POST", `/${wsId}/prs/${prId}/setup`, {
      grant: true,
      script: "echo something else",
    });
    expect(stale.status).toBe(409);
    expect(existsSync(join(worktreePath, "setup-ran.txt"))).toBe(false);

    const ok = await call("POST", `/${wsId}/prs/${prId}/setup`, {
      grant: true,
      script: "echo hello > setup-ran.txt",
    });
    expect(ok.status).toBe(200);
    const events = await progress(wsId, prId);
    expect(events.at(-1)).toMatchObject({ type: "done", phase: "setup", status: "succeeded" });
    expect(readFileSync(join(worktreePath, "setup-ran.txt"), "utf8")).toBe("hello\n");

    const declined = await call("POST", `/${wsId}/prs/${prId}/setup`, { grant: false });
    expect(((await declined.json()) as { setupConsent: string }).setupConsent).toBe("declined");
  });

  it("removes a PR's worktree, and archives the rest while keeping the clone", async () => {
    const { wsId, prId, worktreePath } = await readyWorkspace();
    const second: PrRef = { provider: "github", owner: "o", repo: "r", number: 3 };
    // PR 3 doesn't exist on the remote, so its clone fails — and archiving
    // still has to cope with a PR that never got a worktree.
    const added = await call("POST", `/${wsId}/prs`, { ref: second });
    const failed = (await added.json()) as { id: string; colorIndex: number };
    expect(failed.colorIndex).toBe(1);
    const events = await progress(wsId, failed.id);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "error" });

    expect((await call("DELETE", `/${wsId}/prs/${prId}`)).status).toBe(200);
    expect(existsSync(worktreePath)).toBe(false);

    // Two archives at once: exactly one proceeds.
    const statuses = (
      await Promise.all([call("POST", `/${wsId}/archive`), call("POST", `/${wsId}/archive`)])
    ).map((res) => res.status);
    expect(statuses.sort()).toEqual([202, 409]);
    for (let i = 0; i < 50; i++) {
      const [row] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, wsId));
      if (row?.status === "archived") break;
      await Bun.sleep(50);
    }
    const [row] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, wsId));
    expect(row).toMatchObject({ status: "archived", error: null });
    expect(existsSync(join(workspacesRoot, ".review", wsId))).toBe(false);
    expect(existsSync(join(workspacesRoot, ".review-repos/github/o/r/.git"))).toBe(true);
    expect((await call("GET", "/")).status).toBe(200);
    expect(((await (await call("GET", "/")).json()) as unknown[]).length).toBe(0);
    expect((await call("POST", `/${wsId}/prs`, { ref })).status).toBe(409);
  });
});
