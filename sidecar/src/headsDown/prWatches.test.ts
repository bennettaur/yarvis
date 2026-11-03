import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos, workspaces } from "../db/schema.ts";
import {
  markMergedWatches,
  markWatchesDelivered,
  undeliveredMergedWatches,
  watchPrMerge,
} from "./prWatches.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

/** One workspace with one repo `acme/api` whose cached PR is `prNumber`, open. */
async function seed(prNumber = 42): Promise<{ workspaceId: string; workspaceRepoId: string }> {
  const [repo] = await db
    .insert(repos)
    .values({
      name: "api",
      owner: "acme",
      repo: "api",
      cloneUrl: "git@github.com:acme/api.git",
      primaryClonePath: "/tmp/primary-api",
    })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name: "billing", slug: "billing", rootPath: "/tmp/billing", status: "active" })
    .returning();
  const [wr] = await db
    .insert(workspaceRepos)
    .values({
      workspaceId: ws!.id,
      repoId: repo!.id,
      branch: "yarvis/billing",
      baseBranch: "main",
      worktreePath: "/tmp/billing/api",
      status: "ready",
    })
    .returning();
  await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber, prState: "open" });
  return { workspaceId: ws!.id, workspaceRepoId: wr!.id };
}

async function setPrState(workspaceRepoId: string, prState: string): Promise<void> {
  await db
    .update(workspaceRepoPr)
    .set({ prState })
    .where(eq(workspaceRepoPr.workspaceRepoId, workspaceRepoId));
}

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr, heads_down_pr_watches RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("PR merge watches", () => {
  it("fires once when the poller caches the watched PR as merged", async () => {
    const { workspaceId, workspaceRepoId } = await seed();
    const watched = await watchPrMerge(db, {
      workspaceId,
      repo: "Acme/API",
      number: 42,
      note: "watch the deploy",
    });
    expect(watched.ok).toBe(true);

    expect(await markMergedWatches(db)).toBe(0);
    expect(await undeliveredMergedWatches(db)).toEqual([]);

    await setPrState(workspaceRepoId, "merged");
    expect(await markMergedWatches(db)).toBe(1);
    // Already marked, so a later tick doesn't wake the loop again.
    expect(await markMergedWatches(db)).toBe(0);

    const merged = await undeliveredMergedWatches(db);
    expect(merged).toEqual([
      expect.objectContaining({
        workspaceId,
        workspaceName: "billing",
        repo: "acme/api",
        prNumber: 42,
        note: "watch the deploy",
      }),
    ]);

    await markWatchesDelivered(
      db,
      merged.map((w) => w.id),
    );
    expect(await undeliveredMergedWatches(db)).toEqual([]);
  });

  it("refuses a PR the workspace doesn't track, and says when it already merged", async () => {
    const { workspaceId, workspaceRepoId } = await seed();

    const wrongNumber = await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 7 });
    expect(wrongNumber).toMatchObject({ ok: false, error: expect.stringContaining("acme/api#7") });
    const wrongRepo = await watchPrMerge(db, { workspaceId, repo: "acme/web", number: 42 });
    expect(wrongRepo.ok).toBe(false);

    await setPrState(workspaceRepoId, "merged");
    expect(await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 42 })).toEqual({
      ok: false,
      alreadyMerged: true,
    });
  });

  it("doesn't fire for a different PR that merged on the same branch", async () => {
    const { workspaceId, workspaceRepoId } = await seed();
    await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 42 });

    await db
      .update(workspaceRepoPr)
      .set({ prNumber: 43, prState: "merged" })
      .where(eq(workspaceRepoPr.workspaceRepoId, workspaceRepoId));
    expect(await markMergedWatches(db)).toBe(0);
  });

  it("re-watching a PR replaces its note", async () => {
    const { workspaceId, workspaceRepoId } = await seed();
    await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 42, note: "first" });
    await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 42, note: "second" });

    await setPrState(workspaceRepoId, "merged");
    await markMergedWatches(db);
    const merged = await undeliveredMergedWatches(db);
    expect(merged.map((w) => w.note)).toEqual(["second"]);
  });
});
