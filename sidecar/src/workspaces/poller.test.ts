import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { getDb } from "../db/client.ts";
import { repos, workspaceRepoPr, workspaceRepos, workspaces } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import { pollOnce, reconcileOrphans } from "./poller.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = getDb(url).db;

/**
 * Builds a GitHubClient whose fetch returns canned payloads keyed by URL. A
 * handler may return `{ __status: <code> }` to simulate an error response.
 */
function clientWith(handlers: (path: string) => unknown): GitHubClient {
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = typeof input === "string" ? input : input.toString();
    const body = handlers(u) as { __status?: number };
    const status = body && typeof body === "object" && body.__status ? body.__status : 200;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return new GitHubClient("test-token", fetchImpl);
}

/** Seeds one active workspace with one ready repo `r<suffix>` on `yarvis/<suffix>`. */
async function seedReadyRepo(suffix = "x"): Promise<string> {
  const [repo] = await db
    .insert(repos)
    .values({
      name: `r${suffix}`,
      owner: `o${suffix}`,
      repo: `r${suffix}`,
      cloneUrl: `git@github.com:o${suffix}/r${suffix}.git`,
      primaryClonePath: `/tmp/primary-${suffix}`,
    })
    .returning();
  const [ws] = await db
    .insert(workspaces)
    .values({ name: suffix, slug: suffix, rootPath: `/tmp/${suffix}`, status: "active" })
    .returning();
  const [wr] = await db
    .insert(workspaceRepos)
    .values({
      workspaceId: ws!.id,
      repoId: repo!.id,
      branch: `yarvis/${suffix}`,
      baseBranch: "main",
      worktreePath: `/tmp/${suffix}/r${suffix}`,
      status: "ready",
    })
    .returning();
  return wr!.id;
}

beforeEach(async () => {
  await sql`TRUNCATE repos, workspaces, workspace_repos, workspace_repo_pr, tasks RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

/** A pulls-list item as returned by `GET /repos/:o/:r/pulls?head=`. */
function pullItem(number: number, state: string) {
  return {
    number,
    title: "t",
    html_url: `https://github.com/acme/widget/pull/${number}`,
    user: { login: "me" },
    draft: false,
    state,
    created_at: "2026-01-01",
    updated_at: "2026-01-02",
  };
}

const CHECKS = (runs: { status: string; conclusion: string }[]) => ({ check_runs: runs });

describe("pollOnce", () => {
  it("caches the PR + failing-check rollup for a ready repo", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/pulls/7")) {
        return {
          state: "open",
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { sha: "abc" },
        };
      }
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "failure" },
        ]);
      }
      return {};
    });

    await pollOnce(db, gh);

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBe(7);
    expect(row?.prState).toBe("open");
    expect(row?.checkRollup).toBe("failure");
    expect(row?.checks).toEqual({ total: 2, success: 1, failure: 1, pending: 0 });
    expect(row?.lastError).toBeNull();
  });

  it("derives a pending rollup when checks are still running", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "in_progress", conclusion: "" },
        ]);
      }
      return {};
    });

    await pollOnce(db, gh);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("pending");
  });

  // The behavior under test: a follow-up push that retriggers a failing check
  // restarts it as `in_progress`; the rollup must report `pending` (work not
  // finalized) rather than the stale `failure` from before the push. The
  // failing count is still preserved on the row so the UI can surface "1
  // failing · N running" alongside the rollup.
  it("derives pending — not failure — when both failing and running checks coexist", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(7, "open")];
      if (path.includes("/pulls/7")) return { state: "open", merged: false, head: { sha: "abc" } };
      if (path.includes("/check-runs")) {
        return CHECKS([
          { status: "completed", conclusion: "success" },
          { status: "completed", conclusion: "failure" },
          { status: "in_progress", conclusion: "" },
        ]);
      }
      return {};
    });

    await pollOnce(db, gh);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.checkRollup).toBe("pending");
    expect(row?.checks).toEqual({ total: 3, success: 1, failure: 1, pending: 1 });
  });

  it("records a no-PR state when no PR exists for the branch", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => (path.includes("head=") ? [] : {}));

    await pollOnce(db, gh);

    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prNumber).toBeNull();
    expect(row?.checkRollup).toBe("none");
    expect(row?.lastPolledAt).not.toBeNull();
  });

  it("marks a merged PR's state as merged", async () => {
    const wrId = await seedReadyRepo();
    const gh = clientWith((path) => {
      if (path.includes("head=")) return [pullItem(9, "closed")];
      if (path.includes("/pulls/9")) {
        return {
          state: "closed",
          merged: true,
          mergeable: null,
          mergeable_state: "clean",
          head: { sha: "z" },
        };
      }
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, gh);
    const [row] = await db.select().from(workspaceRepoPr).where(eqWr(wrId));
    expect(row?.prState).toBe("merged");
    expect(row?.checkRollup).toBe("none");
  });

  it("records a per-repo error and keeps polling the rest of the cycle", async () => {
    const a = await seedReadyRepo("a");
    const b = await seedReadyRepo("b");
    // Repo a's lookup 500s; repo b succeeds. The cycle must finish both.
    const gh = clientWith((path) => {
      if (path.includes("/ra/") && path.includes("head=")) return { __status: 500 };
      if (path.includes("head=")) return [pullItem(3, "open")];
      if (path.includes("/pulls/3")) return { state: "open", merged: false, head: { sha: "s" } };
      if (path.includes("/check-runs")) return CHECKS([]);
      return {};
    });

    await pollOnce(db, gh);

    const [rowA] = await db.select().from(workspaceRepoPr).where(eqWr(a));
    const [rowB] = await db.select().from(workspaceRepoPr).where(eqWr(b));
    expect(rowA?.lastError).not.toBeNull();
    expect(rowB?.prNumber).toBe(3); // the loop continued past a's failure
  });

  it("backs off the whole cycle on a 429 rate limit", async () => {
    await seedReadyRepo("a");
    await seedReadyRepo("b");
    // Both repos would 429; the cycle must abort after the first, so only one
    // PR row is ever written (poll order across the two repos is unspecified).
    const gh = clientWith((path) => (path.includes("head=") ? { __status: 429 } : {}));

    await pollOnce(db, gh);

    const rows = await db.select().from(workspaceRepoPr);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastError).toContain("429");
  });
});

describe("reconcileOrphans", () => {
  it("errors a stranded creating workspace but leaves a fresh one", async () => {
    const old = new Date(Date.now() - 5 * 60_000);
    const [stranded] = await db
      .insert(workspaces)
      .values({
        name: "old",
        slug: "old",
        rootPath: "/tmp/old",
        status: "creating",
        updatedAt: old,
      })
      .returning();
    const [fresh] = await db
      .insert(workspaces)
      .values({ name: "new", slug: "new", rootPath: "/tmp/new", status: "creating" })
      .returning();

    await reconcileOrphans(db);

    const [a] = await db.select().from(workspaces).where(eq(workspaces.id, stranded!.id));
    const [b] = await db.select().from(workspaces).where(eq(workspaces.id, fresh!.id));
    expect(a?.status).toBe("error");
    expect(b?.status).toBe("creating"); // within the age margin, untouched
  });
});

function eqWr(wrId: string) {
  return eq(workspaceRepoPr.workspaceRepoId, wrId);
}
