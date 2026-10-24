import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { reviewWorkspacePrs } from "../db/schema.ts";
import { latestReviewMark, providerMarks } from "../pr/reviewMarks.ts";
import type { PrRef, ViewerReview } from "../pr/types.ts";
import { reviewGit } from "./git.ts";
import type { ReviewProgressEvent } from "./progress.ts";
import { markReviewed } from "./reviewMarks.ts";
import { createReviewWorkspaceRoutes } from "./routes.ts";
import type { ReviewDeps } from "./service.ts";
import { refForReviewed } from "./sinceReview.ts";
import { createTestRemote, sh, type TestRemote } from "./testRepo.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1, onnotice: () => {} });

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

let remote: TestRemote;
/** What the fake provider says the viewer reviewed. */
let providerReviews: ViewerReview[];

const deps = (): ReviewDeps => ({
  loadPr: async () => ({
    title: "Feature work",
    author: "octocat",
    headRef: "feature",
    baseRef: "main",
    fromFork: true,
  }),
  remoteUrlFor: async () => remote.url,
  credentialsFor: () => undefined,
  setupScriptFor: async () => null,
  git: () => reviewGit({ allowFileProtocol: true }),
  markProvider: () => ({
    viewerReviews: async () => providerReviews,
    commitsSince: async () => ({ exists: true, commits: null, rewritten: false }),
    headSha: async () => null,
  }),
});

const app = new Hono().route("/rw", createReviewWorkspaceRoutes(config, { deps }));
const db = getDb(url).db;
const ref: PrRef = { provider: "github", owner: "o", repo: "r", number: 1 };

const call = (method: string, path: string) => app.request(`/rw${path}`, { method });
async function getJson<T>(path: string): Promise<T> {
  const res = await call("GET", path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function waitForProgress(wsId: string, prId: string): Promise<ReviewProgressEvent[]> {
  const text = await (await call("GET", `/${wsId}/prs/${prId}/progress`)).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as ReviewProgressEvent);
}

async function readyPr(): Promise<{ wsId: string; prId: string; headSha: string; base: string }> {
  const res = await app.request("/rw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Review", refs: [ref] }),
  });
  const ws = (await res.json()) as { id: string; prs: { id: string }[] };
  const prId = ws.prs[0]?.id as string;
  expect((await waitForProgress(ws.id, prId)).at(-1)).toMatchObject({ status: "ready" });
  const [row] = await db.select().from(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, prId));
  return { wsId: ws.id, prId, headSha: row?.headSha as string, base: `/${ws.id}/prs/${prId}` };
}

async function refresh(wsId: string, prId: string): Promise<void> {
  expect((await call("POST", `/${wsId}/prs/${prId}/refresh`)).status).toBe(202);
  expect((await waitForProgress(wsId, prId)).at(-1)).toMatchObject({ status: "ready" });
}

const clonePath = () => join(config.workspacesRoot, ".review-repos/github/o/r");

beforeEach(async () => {
  await sql`TRUNCATE review_workspaces, review_workspace_prs, pr_review_marks RESTART IDENTITY CASCADE`;
  providerMarks.forget();
  config.workspacesRoot = mkdtempSync(join(tmpdir(), "yarvis-review-root-"));
  remote = createTestRemote();
  providerReviews = [];
});

afterEach(() => {
  rmSync(config.workspacesRoot, { recursive: true, force: true });
  rmSync(remote.root, { recursive: true, force: true });
});

afterAll(async () => {
  await sql.end();
});

interface LastReview {
  mark: { headSha: string; source: string; mergeBaseSha: string | null } | null;
  shaExists: boolean | null;
  upToDate: boolean;
}

describe("review marks in a review workspace", () => {
  it("has no last review until one is marked, then pins it", async () => {
    const { headSha, base } = await readyPr();
    expect(await getJson<LastReview>(`${base}/last-review`)).toMatchObject({
      mark: null,
      upToDate: false,
    });
    expect((await call("GET", `${base}/since-review`)).status).toBe(404);

    const marked = await call("POST", `${base}/review-mark`);
    expect(marked.status).toBe(201);
    expect(await marked.json()).toMatchObject({ headSha, source: "manual" });
    expect(await getJson<LastReview>(`${base}/last-review`)).toMatchObject({
      mark: { headSha, source: "manual" },
      shaExists: true,
      upToDate: true,
    });
    expect(sh(clonePath(), "rev-parse", refForReviewed("gh-o-r-1", headSha)).trim()).toBe(headSha);
  });

  it("reads a review made on the provider, and shows what changed since it after a push", async () => {
    const { wsId, prId, headSha: reviewed, base } = await readyPr();
    providerReviews = [{ headSha: reviewed, submittedAt: new Date().toISOString() }];
    const pushed = remote.pushToPr("src/added.ts", "export const added = true;\n");
    await refresh(wsId, prId);

    const last = await getJson<LastReview>(`${base}/last-review`);
    expect(last).toMatchObject({
      mark: { headSha: reviewed, source: "provider" },
      upToDate: false,
    });

    const since = await getJson<{
      fromHeadSha: string;
      toHeadSha: string;
      rebased: boolean;
      files: { path: string; status: string; additions: number }[];
      commits: { sha: string; isNew: boolean }[];
    }>(`${base}/since-review`);
    expect(since).toMatchObject({ fromHeadSha: reviewed, toHeadSha: pushed, rebased: false });
    expect(since.files).toEqual([
      expect.objectContaining({ path: "src/added.ts", status: "added", additions: 1 }),
    ]);
    expect(since.commits.map((c) => [c.sha, c.isNew])).toEqual([
      [pushed, true],
      [reviewed, false],
    ]);
    // The merge-base worked out for the provider's mark is kept on it.
    expect((await latestReviewMark(db, ref))?.mergeBaseSha).toMatch(/^[0-9a-f]{40}$/);

    const file = await getJson<{ patch: string; original: unknown; modified: { content: string } }>(
      `${base}/since-review/file?path=src/added.ts`,
    );
    expect(file.original).toBeNull();
    expect(file.modified.content).toContain("added = true");
    expect(file.patch).toContain("+export const added = true;");
    expect((await call("GET", `${base}/since-review/file?path=src/a.ts`)).status).toBe(404);
  });

  it("lists commits with what is new since an explicit `from`, and diffs one", async () => {
    const { wsId, prId, headSha: first, base } = await readyPr();
    const pushed = remote.pushToPr("src/a.ts", "export const a = 3;\n");
    await refresh(wsId, prId);

    const listed = await getJson<{
      fromHeadSha: string;
      commits: { sha: string; isNew: boolean }[];
    }>(`${base}/commits?from=${first}`);
    expect(listed.fromHeadSha).toBe(first);
    expect(listed.commits.map((c) => [c.sha, c.isNew])).toEqual([
      [pushed, true],
      [first, false],
    ]);

    const files = await getJson<{ parentSha: string; files: { path: string }[] }>(
      `${base}/commits/${pushed}/diff`,
    );
    expect(files).toMatchObject({ parentSha: first, files: [{ path: "src/a.ts" }] });
    const diff = await getJson<{ patch: string; original: { content: string } }>(
      `${base}/commits/${pushed}/diff?path=src/a.ts`,
    );
    expect(diff.original.content).toContain("a = 2");
    expect(diff.patch).toContain("+export const a = 3;");
  });

  it("without a mark, commits list with nothing flagged new", async () => {
    const { base } = await readyPr();
    const listed = await getJson<{ fromHeadSha: null; commits: { isNew: boolean }[] }>(
      `${base}/commits`,
    );
    expect(listed.fromHeadSha).toBeNull();
    expect(listed.commits.length).toBeGreaterThan(0);
    expect(listed.commits.every((c) => !c.isNew)).toBe(true);
  });

  it("validates shas and paths", async () => {
    const { base, headSha } = await readyPr();
    expect((await call("GET", `${base}/since-review?from=main`)).status).toBe(400);
    expect((await call("GET", `${base}/commits?from=HEAD~1`)).status).toBe(400);
    expect((await call("GET", `${base}/commits/HEAD/diff`)).status).toBe(400);
    expect(
      (await call("GET", `${base}/since-review/file?path=../etc/passwd&from=${headSha}`)).status,
    ).toBe(400);
    expect((await call("GET", `${base}/commits/${headSha}/diff?path=a//b`)).status).toBe(400);
    // A commit outside the PR's own range, like the base branch's.
    const mainTip = sh(remote.work, "rev-parse", "main").trim();
    expect((await call("GET", `${base}/commits/${mainTip}/diff`)).status).toBe(404);
    // A sha nobody has can't be compared from.
    expect((await call("GET", `${base}/since-review?from=${"b".repeat(40)}`)).status).toBe(404);
  });

  it("a mark recorded by a provider route pins its commit in the review clone", async () => {
    const { headSha } = await readyPr();
    await markReviewed(db, config, { ref, headSha, source: "review" }, deps());
    const pinned = refForReviewed("gh-o-r-1", headSha);
    for (let i = 0; i < 100; i++) {
      const res = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", pinned], {
        cwd: clonePath(),
      });
      if (res.exitCode === 0) return;
      await Bun.sleep(20);
    }
    throw new Error("the reviewed commit was never pinned");
  });
});
