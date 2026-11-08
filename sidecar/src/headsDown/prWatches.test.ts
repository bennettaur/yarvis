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

async function addWorkspace(slug: string): Promise<string> {
  const [ws] = await db
    .insert(workspaces)
    .values({ name: slug, slug, rootPath: `/tmp/${slug}`, status: "active" })
    .returning();
  return ws!.id;
}

/** The repo `acme/<name>`, created on first use. */
async function repoId(name: string): Promise<string> {
  const [existing] = await db.select().from(repos).where(eq(repos.name, name));
  if (existing) return existing.id;
  const [repo] = await db
    .insert(repos)
    .values({
      name,
      owner: "acme",
      repo: name,
      cloneUrl: `git@github.com:acme/${name}.git`,
      primaryClonePath: `/tmp/primary-${name}`,
    })
    .returning();
  return repo!.id;
}

/** Adds repo `acme/<name>` to a workspace, with `prNumber` as its cached open PR. */
async function addRepo(workspaceId: string, name: string, prNumber: number): Promise<string> {
  const [wr] = await db
    .insert(workspaceRepos)
    .values({
      workspaceId,
      repoId: await repoId(name),
      branch: `yarvis/${name}`,
      baseBranch: "main",
      worktreePath: `/tmp/${workspaceId}/${name}`,
      status: "ready",
    })
    .returning();
  await db.insert(workspaceRepoPr).values({ workspaceRepoId: wr!.id, prNumber, prState: "open" });
  return wr!.id;
}

/** One workspace with one repo `acme/api` whose cached PR is #42, open. */
async function seed(): Promise<{ workspaceId: string; workspaceRepoId: string }> {
  const workspaceId = await addWorkspace("billing");
  return { workspaceId, workspaceRepoId: await addRepo(workspaceId, "api", 42) };
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

  it("takes the repo by the name get_workspace_status shows", async () => {
    const { workspaceId } = await seed();
    expect(await watchPrMerge(db, { workspaceId, repo: "api", number: 42 })).toEqual({ ok: true });
  });

  it("refuses a PR the workspace doesn't track, or one that can't merge any more", async () => {
    const { workspaceId, workspaceRepoId } = await seed();

    const wrongNumber = await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 7 });
    expect(wrongNumber).toMatchObject({ ok: false, error: expect.stringContaining("acme/api#7") });
    const wrongRepo = await watchPrMerge(db, { workspaceId, repo: "acme/web", number: 42 });
    expect(wrongRepo.ok).toBe(false);

    await setPrState(workspaceRepoId, "closed");
    expect(await watchPrMerge(db, { workspaceId, repo: "api", number: 42 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("closed without merging"),
    });

    await setPrState(workspaceRepoId, "merged");
    expect(await watchPrMerge(db, { workspaceId, repo: "acme/api", number: 42 })).toEqual({
      ok: false,
      alreadyMerged: true,
    });
  });

  it("refuses a repo whose worktree was removed, since the poller no longer reads it", async () => {
    const { workspaceId, workspaceRepoId } = await seed();
    await db
      .update(workspaceRepos)
      .set({ status: "removed" })
      .where(eq(workspaceRepos.id, workspaceRepoId));
    expect(await watchPrMerge(db, { workspaceId, repo: "api", number: 42 })).toMatchObject({
      ok: false,
      error: expect.stringContaining("removed"),
    });
  });

  it("matches the watched PR by workspace and repo", async () => {
    const billing = await addWorkspace("billing");
    const apiInBilling = await addRepo(billing, "api", 42);
    await addRepo(billing, "web", 9);
    const other = await addWorkspace("other");
    await addRepo(other, "api", 50);

    expect((await watchPrMerge(db, { workspaceId: billing, repo: "web", number: 9 })).ok).toBe(
      true,
    );
    // The same repo's PR in another workspace isn't this workspace's to watch.
    expect((await watchPrMerge(db, { workspaceId: billing, repo: "api", number: 50 })).ok).toBe(
      false,
    );

    // A merge of the workspace's other repo doesn't fire the web watch.
    await setPrState(apiInBilling, "merged");
    expect(await markMergedWatches(db)).toBe(0);
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

  it("delivers only the watches a pass was told about, so one merging mid-pass reaches the next", async () => {
    const first = await addWorkspace("first");
    const firstRepo = await addRepo(first, "api", 1);
    const second = await addWorkspace("second");
    const secondRepo = await addRepo(second, "web", 2);
    await watchPrMerge(db, { workspaceId: first, repo: "api", number: 1 });
    await watchPrMerge(db, { workspaceId: second, repo: "web", number: 2 });

    await setPrState(firstRepo, "merged");
    await markMergedWatches(db, new Date("2026-11-03T10:00:00Z"));
    const toldThisPass = await undeliveredMergedWatches(db);

    await setPrState(secondRepo, "merged");
    await markMergedWatches(db, new Date("2026-11-03T10:05:00Z"));
    await markWatchesDelivered(
      db,
      toldThisPass.map((w) => w.id),
    );

    const left = await undeliveredMergedWatches(db);
    expect(left.map((w) => w.prNumber)).toEqual([2]);
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
