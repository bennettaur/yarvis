/**
 * Background poller that keeps each active workspace repo's PR + checks cache
 * (`workspace_repo_pr`) fresh from its provider. This is the app's only
 * background worker; it's started from `server.ts` after migrations. The UI
 * reads the cached rows (via `getWorkspace`) and never calls a provider on
 * render. A repo's provider is derived from its clone URL, so GitHub and Azure
 * DevOps repos are both refreshed in one cycle.
 */

import { and, eq, inArray, lt } from "drizzle-orm";
import { AzureDevOpsClient, isAllowedAzureOrgUrl } from "../azure/client.ts";
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
import { parseRepoRemote } from "./service.ts";

type CheckRollup = WorkspaceRepoPr["checkRollup"];

/** The provider clients a poll cycle has available (whichever tokens are set). */
export interface PollerClients {
  github?: GitHubClient;
  azure?: AzureDevOpsClient;
}

const POLL_INTERVAL_MS = 60_000;
/** On startup, workspaces stuck in a transient state older than this are an
 *  interrupted run (the sidecar died mid-provision/archive) and get flipped to
 *  `error` so the UI offers a retry. The margin avoids racing a fresh create. */
const ORPHAN_AGE_MS = 2 * 60_000;

/**
 * Pending wins over failure: while any check on the latest commit is still
 * running, the PR's outcome is not finalized. If we showed "failure" the
 * moment one check went red we'd hide the fact that fresh checks are queued
 * after a follow-up push, which is the most common reason users come back to
 * a "failing" PR. The per-bucket counts on the cached row still let the UI
 * surface the failing count alongside the running count.
 */
function deriveRollup(checks: ChecksSummary): CheckRollup {
  if (checks.total === 0) return "none";
  if (checks.pending > 0) return "pending";
  if (checks.failure > 0) return "failure";
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

/** The "no PR found for this branch yet" cache values, shared by both providers. */
const NO_PR = {
  prNumber: null,
  prUrl: null,
  prState: null,
  isDraft: null,
  mergeable: null,
  checkRollup: "none",
  checks: null,
} as const;

/** Refreshes the PR cache for one GitHub repo's branch. */
async function pollGithubRepo(
  db: Db,
  gh: GitHubClient,
  workspaceRepoId: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  const pr = await gh.findPrByBranch(owner, repo, branch);
  if (!pr) {
    // No PR yet is the common early state — represent it explicitly so the UI
    // can show "no PR" rather than "not polled".
    await upsertPr(db, workspaceRepoId, { ...NO_PR, lastPolledAt: new Date(), lastError: null });
    return;
  }
  const status = await gh.prStatus(owner, repo, pr.number);
  await upsertPr(db, workspaceRepoId, {
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
}

/** Refreshes the PR cache for one Azure DevOps repo's branch. Azure check
 *  rollups aren't fetched here (policy evaluations need a per-PR call), so the
 *  row records the PR identity/state with an empty check summary. */
async function pollAzureRepo(
  db: Db,
  az: AzureDevOpsClient,
  workspaceRepoId: string,
  project: string,
  repo: string,
  branch: string,
): Promise<void> {
  const pr = await az.findPrByBranch(project, repo, branch);
  if (!pr) {
    await upsertPr(db, workspaceRepoId, { ...NO_PR, lastPolledAt: new Date(), lastError: null });
    return;
  }
  await upsertPr(db, workspaceRepoId, {
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    isDraft: pr.draft,
    mergeable: pr.mergeable,
    checkRollup: "none",
    checks: null,
    lastPolledAt: new Date(),
    lastError: null,
  });
}

/** Refreshes the PR cache for every ready repo in an active workspace. */
export async function pollOnce(db: Db, clients: PollerClients): Promise<void> {
  const rows = await db
    .select({ wr: workspaceRepos, repo: repos })
    .from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(eq(workspaces.status, "active"), eq(workspaceRepos.status, "ready")));

  for (const { wr, repo } of rows) {
    try {
      const remote = parseRepoRemote(repo.cloneUrl);
      if (remote?.provider === "azure") {
        // Skip Azure repos we can't reach: no client (token/org unset) or a
        // different org than this client is configured for (a cross-org lookup
        // would 404 and just churn lastError).
        if (!clients.azure || clients.azure.org.toLowerCase() !== remote.org.toLowerCase())
          continue;
        await pollAzureRepo(db, clients.azure, wr.id, remote.project, remote.repo, wr.branch);
        continue;
      }
      if (!clients.github) continue;
      // GitHub owner/repo are stored on the row at registration; fall back to
      // them when the clone URL doesn't parse.
      const owner = remote?.provider === "github" ? remote.owner : repo.owner;
      const name = remote?.provider === "github" ? remote.repo : repo.repo;
      await pollGithubRepo(db, clients.github, wr.id, owner, name, wr.branch);
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
 * Starts the poller. No-op without a database or any provider token. Returns a
 * stop function. The first tick reconciles interrupted runs before polling.
 * A repo is polled only if a client for its provider is available, so a
 * GitHub-only or Azure-only token set still refreshes the repos it can reach.
 */
export function startWorkspacePoller(config: Config): () => void {
  const { githubToken, azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
  if (!config.databaseUrl || (!githubToken && !azureDevopsToken)) return () => {};
  const db = getDb(config.databaseUrl).db;
  const clients: PollerClients = {
    github: githubToken ? new GitHubClient(githubToken) : undefined,
    azure:
      azureDevopsToken && azureDevopsOrgUrl && isAllowedAzureOrgUrl(azureDevopsOrgUrl)
        ? new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl)
        : undefined,
  };

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap a slow cycle with the next
    running = true;
    try {
      await pollOnce(db, clients);
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
