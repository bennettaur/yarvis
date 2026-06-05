/**
 * Background poller that keeps each active workspace repo's PR + checks cache
 * (`workspace_repo_pr`) fresh from GitHub. This is the app's only background
 * worker; it's started from `server.ts` after migrations. The UI reads the
 * cached rows (via `getWorkspace`) and never calls GitHub on render.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import {
  repos,
  type WorkspaceRepoPr,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import { type ChecksSummary, GitHubClient } from "../github/client.ts";

type CheckRollup = WorkspaceRepoPr["checkRollup"];

const POLL_INTERVAL_MS = 60_000;
/** On startup, workspaces stuck in a transient state older than this are an
 *  interrupted run (the sidecar died mid-provision/archive) and get flipped to
 *  `error` so the UI offers a retry. The margin avoids racing a fresh create. */
const ORPHAN_AGE_MS = 2 * 60_000;

function deriveRollup(checks: ChecksSummary): CheckRollup {
  if (checks.total === 0) return "none";
  if (checks.failure > 0) return "failure";
  if (checks.pending > 0) return "pending";
  return "success";
}

/** Upserts the PR cache row for a workspace repo (1:1 via the unique index). */
async function upsertPr(
  db: Db,
  workspaceRepoId: string,
  values: Partial<typeof workspaceRepoPr.$inferInsert>,
): Promise<void> {
  const row = { workspaceRepoId, updatedAt: new Date(), ...values };
  await db
    .insert(workspaceRepoPr)
    .values(row)
    .onConflictDoUpdate({ target: workspaceRepoPr.workspaceRepoId, set: row });
}

/** Refreshes the PR cache for every ready repo in an active workspace. */
export async function pollOnce(db: Db, gh: GitHubClient): Promise<void> {
  const rows = await db
    .select({ wr: workspaceRepos, repo: repos })
    .from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(eq(workspaces.status, "active"), eq(workspaceRepos.status, "ready")));

  for (const { wr, repo } of rows) {
    try {
      const pr = await gh.findPrByBranch(repo.owner, repo.repo, wr.branch);
      if (!pr) {
        // No PR yet is the common early state — represent it explicitly so the
        // UI can show "no PR" rather than "not polled".
        await upsertPr(db, wr.id, {
          prNumber: null,
          prUrl: null,
          prState: null,
          isDraft: null,
          mergeable: null,
          checkRollup: "none",
          checks: null,
          lastPolledAt: new Date(),
          lastError: null,
        });
        continue;
      }
      const status = await gh.prStatus(repo.owner, repo.repo, pr.number);
      await upsertPr(db, wr.id, {
        prNumber: pr.number,
        prUrl: pr.url,
        prState: status.merged ? "merged" : status.state,
        isDraft: pr.draft,
        mergeable: status.mergeableState,
        checkRollup: deriveRollup(status.checks),
        checks: status.checks,
        lastPolledAt: new Date(),
        lastError: null,
      });
    } catch (e) {
      // One repo's failure (rate limit, 5xx) must not abort the cycle.
      const message = e instanceof Error ? e.message : String(e);
      await upsertPr(db, wr.id, { lastPolledAt: new Date(), lastError: message });
      if (/-> (403|429)$/.test(message)) {
        // Hit a rate/abuse limit (403 secondary / 429) — stop this cycle and
        // let the next one retry. 409 (Conflict) is unrelated and not matched.
        console.warn("[workspace poller] rate limited, backing off this cycle");
        return;
      }
    }
  }
}

/**
 * Marks workspaces left in a transient state by an interrupted run as `error`,
 * along with their repos still mid-provision. Runs once at startup. Exported
 * for testing.
 */
export async function reconcileOrphans(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  // creating | archiving are the only transient states a restart can strand.
  const stuck = await db
    .update(workspaces)
    .set({ status: "error", error: "interrupted; retry provisioning", updatedAt: new Date() })
    .where(
      and(inArray(workspaces.status, ["creating", "archiving"]), lt(workspaces.updatedAt, cutoff)),
    )
    .returning({ id: workspaces.id });
  if (stuck.length) {
    // Scope the repo reset to the stranded workspaces so a repo provisioning in
    // a healthy workspace (created since startup) is never touched.
    await db
      .update(workspaceRepos)
      .set({ status: "error", error: "interrupted" })
      .where(
        and(
          inArray(
            workspaceRepos.workspaceId,
            stuck.map((s) => s.id),
          ),
          eq(workspaceRepos.status, "provisioning"),
        ),
      );
    console.warn(`[workspace poller] reconciled ${stuck.length} interrupted workspace(s)`);
  }
}

/**
 * Starts the poller. No-op without a database or GitHub token. Returns a stop
 * function. The first tick reconciles interrupted runs before polling.
 */
export function startWorkspacePoller(config: Config): () => void {
  if (!config.databaseUrl || !config.secrets.githubToken) return () => {};
  const db = getDb(config.databaseUrl).db;
  const gh = new GitHubClient(config.secrets.githubToken);

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap a slow cycle with the next
    running = true;
    try {
      await pollOnce(db, gh);
    } catch (e) {
      console.error("[workspace poller] cycle failed:", e);
    } finally {
      running = false;
    }
  };

  void reconcileOrphans(db)
    .catch((e) => console.error("[workspace poller] reconcile failed:", e))
    .finally(() => void tick());

  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  return () => clearInterval(timer);
}
