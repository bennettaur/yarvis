/**
 * Background poller that keeps each active workspace repo's PR + checks cache
 * (`workspace_repo_pr`) fresh from its provider. This is the app's only
 * background worker; it's started from `server.ts` after migrations. The UI
 * reads the cached rows (via `getWorkspace`) and never calls a provider on
 * render. A repo's provider is derived from its clone URL, so GitHub and Azure
 * DevOps repos are both refreshed in one cycle.
 *
 * GitHub repos are read in batched GraphQL queries, two kinds per cycle. Every
 * known, unmerged PR is re-read by number on a slow timer whether or not
 * anyone is looking, so every workspace's badge stays current. Branches are
 * read on a fast timer only while their workspace is on screen, which is also
 * how a new PR is found. The workspace routes record which reads the UI made.
 * Views are tracked in memory per sidecar process, so a named instance's UI
 * doesn't trigger polling in the main instance.
 */

import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { AzureDevOpsClient, isAllowedAzureOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import {
  type Repo,
  repos,
  type WorkspaceRepoPr,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import {
  type BatchResult,
  type ChecksSummary,
  createGitHubClient,
  type GitHubClient,
  POLL_BATCH_SIZE,
  type PolledPr,
  summarizeCheckItems,
} from "../github/client.ts";
import { GitHubError } from "../github/errors.ts";
import { parseRepoRemote } from "./service.ts";

type CheckRollup = WorkspaceRepoPr["checkRollup"];

/** The provider clients a poll cycle has available (whichever tokens are set). */
export interface PollerClients {
  github?: GitHubClient;
  azure?: AzureDevOpsClient;
}

/** How often the poller checks which repos are due a refresh. */
const TICK_MS = 30_000;
/** A repo in the workspace the user has open. */
const FOCUSED_POLL_MS = 60_000;
/**
 * Every known PR that isn't merged, and a branch with no PR yet seen in the
 * workspace list. Also a merged or closed PR in the open workspace, which has
 * little left to change.
 */
const BACKGROUND_POLL_MS = 15 * 60_000;
/**
 * How long a read keeps a workspace counted as viewed. The UI re-reads every
 * 20s while the window has focus, so this survives a slow tick but lapses
 * within a minute of the user switching away or to another workspace.
 */
const VIEW_WINDOW_MS = 60_000;
/**
 * A repo polled during one tick is a little under an interval old by the tick
 * an interval later, since its timestamp is taken after the provider answers.
 * Without this slack the focused cadence would slip to 90s.
 */
const DUE_SLACK_MS = TICK_MS / 2;

/** When the UI last read each workspace's detail, by workspace id. */
const workspaceViewedAt = new Map<string, number>();
/** When the UI last read the workspace list, whose rows show PR badges. Never, to start. */
let listViewedAt = Number.NEGATIVE_INFINITY;

/** Records that the UI read one workspace's detail while the user was looking at it. */
export function markWorkspaceViewed(workspaceId: string, now = Date.now()): void {
  workspaceViewedAt.set(workspaceId, now);
}

/** Records that the UI read the workspace list while the user was looking at it. */
export function markWorkspaceListViewed(now = Date.now()): void {
  listViewedAt = now;
}

/** Test hook: forget every recorded view. */
export function resetWorkspaceViews(): void {
  workspaceViewedAt.clear();
  listViewedAt = Number.NEGATIVE_INFINITY;
}

/** What decides whether a repo is due a refresh: its workspace and its cached row. */
export interface PollCandidate {
  workspaceId: string;
  prNumber: number | null;
  prState: string | null;
  lastPolledAt: Date | null;
}

/**
 * How a due repo is read. `branch` finds whatever PR is on the branch now, so
 * it notices a new one; `number` re-reads a PR already known, which is cheaper.
 */
export type RefreshMode = "branch" | "number";

/** A repo whose cached PR is older than this, measured from its last poll, is due. */
function dueAfter(candidate: PollCandidate, intervalMs: number, now: number): boolean {
  // A repo with no cached row yet has never been polled.
  if (candidate.lastPolledAt === null) return true;
  return now - candidate.lastPolledAt.getTime() >= intervalMs - DUE_SLACK_MS;
}

/**
 * Whether a known PR's 15-minute window has turned since its last read. Known
 * PRs are read on wall-clock windows rather than each on its own timer, so
 * they all come due on the same tick and share one request; timers that
 * drifted apart would split them into many small ones.
 */
function windowTurned(candidate: PollCandidate, now: number): boolean {
  if (candidate.lastPolledAt === null) return true;
  const window = (t: number) => Math.floor(t / BACKGROUND_POLL_MS);
  return window(candidate.lastPolledAt.getTime()) < window(now);
}

/** How a repo should be refreshed this tick, or null when it isn't due. */
export function dueRefresh(candidate: PollCandidate, now = Date.now()): RefreshMode | null {
  const viewedAt = workspaceViewedAt.get(candidate.workspaceId);
  const focused = viewedAt !== undefined && now - viewedAt < VIEW_WINDOW_MS;
  const settled = candidate.prState === "merged" || candidate.prState === "closed";
  // The workspace the user has open is read by branch, so a PR opened on it
  // shows up within a minute. A settled PR there has little left to change.
  if (focused) {
    return dueAfter(candidate, settled ? BACKGROUND_POLL_MS : FOCUSED_POLL_MS, now)
      ? "branch"
      : null;
  }
  // Every other known PR is re-read by number, whether or not anyone is
  // looking, so every badge stays current. A merged PR won't change again.
  if (candidate.prNumber !== null) {
    if (candidate.prState === "merged") return null;
    return windowTurned(candidate, now) ? "number" : null;
  }
  // A branch with no PR yet is only looked at while its badge is on screen.
  const listVisible = now - listViewedAt < VIEW_WINDOW_MS;
  return listVisible && dueAfter(candidate, BACKGROUND_POLL_MS, now) ? "branch" : null;
}

/** Whether a repo's cached PR is older than its refresh interval. */
export function isDueForRefresh(candidate: PollCandidate, now = Date.now()): boolean {
  return dueRefresh(candidate, now) !== null;
}

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
  reviewDecision: null,
} as const;

/** What the PR cache holds for a branch, minus the bookkeeping columns. */
export type BranchPr = Pick<
  WorkspaceRepoPr,
  | "prNumber"
  | "prUrl"
  | "prState"
  | "isDraft"
  | "mergeable"
  | "checkRollup"
  | "checks"
  | "reviewDecision"
>;

/** What the PR cache holds for a GitHub PR the poller read, or for a branch with none. */
function toBranchPr(pr: PolledPr | null): BranchPr {
  // No PR yet is the common early state. Cache it explicitly so the UI can
  // show "no PR" rather than "not polled".
  if (!pr) return NO_PR;
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.status.merged ? "merged" : pr.status.state,
    isDraft: pr.draft,
    mergeable: pr.status.mergeableState,
    checkRollup: deriveRollup(pr.status.checks),
    checks: pr.status.checks,
    reviewDecision: pr.reviewDecision,
  };
}

/**
 * The PR on one GitHub branch and where its checks stand, in three reads that
 * can each fall back to REST. Backs the worktree PR lookup, and the poller's
 * open workspace when GraphQL can't run its batched read.
 */
async function githubBranchPr(
  gh: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<BranchPr> {
  const pr = await gh.findPrByBranch(owner, repo, branch);
  if (!pr) return NO_PR;
  const status = await gh.prStatus(owner, repo, pr.number);
  // The verdict costs an extra request, so only ask where it can change what
  // the user does next: a draft or an already-closed PR isn't waiting on review.
  // It is also the one enrichment here that a narrower token may not be allowed
  // to make, so a failure drops the verdict rather than the whole refresh —
  // otherwise a repo-scoped 403 would freeze that repo's check status and, read
  // as a rate limit by the caller, abandon the rest of the cycle.
  const awaitingReview = !status.merged && status.state === "open" && !pr.draft;
  const reviewDecision = awaitingReview
    ? await gh.prReviewDecision(owner, repo, pr.number).catch(() => null)
    : null;
  return toBranchPr({ number: pr.number, url: pr.url, draft: pr.draft, status, reviewDecision });
}

/** The PR on one Azure DevOps branch and where its CI policies stand. */
async function azureBranchPr(
  az: AzureDevOpsClient,
  project: string,
  repo: string,
  branch: string,
): Promise<BranchPr> {
  const pr = await az.findPrByBranch(project, repo, branch);
  if (!pr) return NO_PR;
  const awaitingReview = pr.state === "open" && !pr.draft;
  // Policy evaluations are a separate read a PAT may lack the scope for. As
  // with GitHub's review verdict, any failure drops the checks rather than the
  // refresh: a 403 here would otherwise be read as a rate limit and end the
  // cycle for every repo after this one. Without a project id they can't be
  // addressed at all, which is "unknown", not "no checks".
  const ciChecks = pr.projectId
    ? await az.prCiChecks(project, pr.projectId, pr.number).catch(() => null)
    : null;
  const checks = ciChecks ? summarizeCheckItems(ciChecks) : null;
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.state,
    isDraft: pr.draft,
    mergeable: pr.mergeable,
    checkRollup: checks ? deriveRollup(checks) : "none",
    checks,
    reviewDecision: awaitingReview ? pr.reviewDecision : null,
  };
}

/**
 * A GitHub repo's owner and name, from its clone URL or, when that doesn't
 * parse, the ones stored on the row at registration.
 */
function githubRepoOf(repo: Repo): { owner: string; repo: string } {
  const remote = parseRepoRemote(repo.cloneUrl);
  return remote?.provider === "github"
    ? { owner: remote.owner, repo: remote.repo }
    : { owner: repo.owner, repo: repo.repo };
}

/**
 * The PR on one of a repo's branches, from whichever provider its clone URL
 * names. Null when no client can reach that provider: no token, or an Azure
 * org other than the configured one, where a lookup would only 404.
 */
async function branchPr(
  clients: PollerClients,
  repo: Repo,
  branch: string,
): Promise<BranchPr | null> {
  const remote = parseRepoRemote(repo.cloneUrl);
  if (remote?.provider === "azure") {
    if (!clients.azure || clients.azure.org.toLowerCase() !== remote.org.toLowerCase()) return null;
    return azureBranchPr(clients.azure, remote.project, remote.repo, branch);
  }
  if (!clients.github) return null;
  const { owner, repo: repoName } = githubRepoOf(repo);
  return githubBranchPr(clients.github, owner, repoName, branch);
}

/** The provider clients the configured tokens allow. */
export function pollerClients(config: Config): PollerClients {
  const { githubToken, azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
  return {
    github: githubToken ? createGitHubClient(config, githubToken) : undefined,
    azure:
      azureDevopsToken && azureDevopsOrgUrl && isAllowedAzureOrgUrl(azureDevopsOrgUrl)
        ? new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl)
        : undefined,
  };
}

/**
 * The PR on a branch the poller doesn't watch — a worktree an agent created
 * beside the workspace's own — read when the user asks rather than cached. Null
 * when no configured provider can answer for this repo.
 */
export function lookupBranchPr(
  config: Config,
  repo: Repo,
  branch: string,
): Promise<BranchPr | null> {
  return branchPr(pollerClients(config), repo, branch);
}

/** A repo the cycle refreshes. */
interface DueRepo {
  wr: typeof workspaceRepos.$inferSelect;
  repo: Repo;
}

/** A known PR the cycle re-reads by number. */
interface DueKnownPr extends DueRepo {
  prNumber: number;
}

/** Whether a failure means the provider's rate limit is spent, so the rest of the cycle should wait. */
function isRateLimited(e: unknown): boolean {
  // GitHub's errors name the reason; Azure's only carry the status, where 403
  // (secondary) and 429 mean a limit and 409 (Conflict) is unrelated.
  if (e instanceof GitHubError) return e.reason === "rate_limited";
  return /-> (403|429)$/.test(e instanceof Error ? e.message : String(e));
}

/** Caches why a repo's refresh failed, and when, so it waits its interval before the next try. */
async function recordError(db: Db, workspaceRepoId: string, e: unknown): Promise<void> {
  const message = e instanceof Error ? e.message : String(e);
  await upsertPr(db, workspaceRepoId, { lastPolledAt: new Date(), lastError: message });
}

/**
 * Refreshes repos one at a time, stopping at the first rate limit. Returns
 * false when it stopped early.
 */
async function refreshEach(
  db: Db,
  due: DueRepo[],
  read: (repo: DueRepo) => Promise<BranchPr | null>,
): Promise<boolean> {
  for (const item of due) {
    try {
      const pr = await read(item);
      if (!pr) continue;
      await upsertPr(db, item.wr.id, { ...pr, lastPolledAt: new Date(), lastError: null });
    } catch (e) {
      // One repo's failure (a 5xx, a deleted repo) must not abort the cycle.
      await recordError(db, item.wr.id, e);
      if (isRateLimited(e)) {
        console.warn("[workspace poller] rate limited, backing off this cycle");
        return false;
      }
    }
  }
  return true;
}

/** `items` in runs of at most {@link POLL_BATCH_SIZE}. */
function inBatches<T>(items: T[]): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += POLL_BATCH_SIZE) {
    batches.push(items.slice(start, start + POLL_BATCH_SIZE));
  }
  return batches;
}

/**
 * Refreshes GitHub repos with batched reads: the branches first, since one of
 * them is what the user is looking at, then the known PRs. Each batch is
 * cached as soon as it's read, so a later batch failing doesn't cost the ones
 * before it. A batch that fails as a whole either ends the cycle (a spent
 * rate limit), falls back to per-repo reads (an outage, for branches only), or
 * records its error on every repo in it.
 */
async function refreshGithub(
  db: Db,
  gh: GitHubClient,
  byBranch: DueRepo[],
  byNumber: DueKnownPr[],
): Promise<void> {
  const batches: {
    items: DueRepo[];
    read: () => Promise<BatchResult<PolledPr | null>[]>;
    /** Whether an outage is worth reading these one at a time instead. */
    fallBackOnOutage: boolean;
  }[] = [
    ...inBatches(byBranch).map((items) => ({
      items,
      fallBackOnOutage: true,
      read: () =>
        gh.branchPrStatuses(items.map((d) => ({ ...githubRepoOf(d.repo), branch: d.wr.branch }))),
    })),
    ...inBatches(byNumber).map((items) => ({
      items,
      fallBackOnOutage: false,
      read: () =>
        gh.prStatusesByNumber(items.map((d) => ({ ...githubRepoOf(d.repo), number: d.prNumber }))),
    })),
  ];
  for (const { items, read, fallBackOnOutage } of batches) {
    let results: BatchResult<PolledPr | null>[];
    try {
      results = await read();
    } catch (e) {
      if (isRateLimited(e)) {
        // No REST fallback here: a background read waits out GraphQL's limit
        // rather than spending the REST budget the PR pages need.
        console.warn("[workspace poller] GitHub rate limited, backing off this cycle");
        return;
      }
      if (fallBackOnOutage && e instanceof GitHubError && e.reason === "upstream_error") {
        // GraphQL can't answer at all (an outage, or a GitHub Enterprise server
        // that can't run the batch). The open workspace is worth the slower
        // per-repo reads, which can use REST; known PRs nobody is looking at
        // wait for the next window instead.
        const finished = await refreshEach(db, items, (d) => {
          const { owner, repo } = githubRepoOf(d.repo);
          return githubBranchPr(gh, owner, repo, d.wr.branch);
        });
        if (!finished) return;
        continue;
      }
      // Anything else (an outage for known PRs, a revoked token, SSO) is every repo's answer.
      for (const item of items) await recordError(db, item.wr.id, e);
      continue;
    }
    for (const [i, result] of results.entries()) {
      const { wr } = items[i] as DueRepo;
      if (result.ok) {
        await upsertPr(db, wr.id, {
          ...toBranchPr(result.value),
          lastPolledAt: new Date(),
          lastError: null,
        });
      } else {
        await recordError(db, wr.id, result.error);
      }
    }
  }
}

/**
 * Refreshes the PR cache for every ready repo in an active workspace that
 * `refreshModeFor` names a refresh for (all of them, by branch, by default).
 * GitHub repos are read in batches; Azure DevOps has no batched read, so its
 * repos go one at a time, by branch.
 */
export async function pollOnce(
  db: Db,
  clients: PollerClients,
  refreshModeFor: (candidate: PollCandidate) => RefreshMode | null = () => "branch",
): Promise<void> {
  const rows = await db
    .select({
      wr: workspaceRepos,
      repo: repos,
      prNumber: workspaceRepoPr.prNumber,
      prState: workspaceRepoPr.prState,
      lastPolledAt: workspaceRepoPr.lastPolledAt,
    })
    .from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .leftJoin(workspaceRepoPr, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .where(and(eq(workspaces.status, "active"), eq(workspaceRepos.status, "ready")));

  const byBranch: DueRepo[] = [];
  const byNumber: DueKnownPr[] = [];
  const azure: DueRepo[] = [];
  for (const row of rows) {
    const mode = refreshModeFor({
      workspaceId: row.wr.workspaceId,
      prNumber: row.prNumber,
      prState: row.prState,
      lastPolledAt: row.lastPolledAt,
    });
    if (mode === null) continue;
    const due = { wr: row.wr, repo: row.repo };
    if (parseRepoRemote(row.repo.cloneUrl)?.provider === "azure") azure.push(due);
    else if (mode === "number" && row.prNumber !== null)
      byNumber.push({ ...due, prNumber: row.prNumber });
    else byBranch.push(due);
  }

  // Each provider has its own rate limit, so one running out doesn't hold up the other.
  if (clients.github) await refreshGithub(db, clients.github, byBranch, byNumber);
  if (azure.length) await refreshEach(db, azure, (d) => branchPr(clients, d.repo, d.wr.branch));
}

/**
 * How recent a poll a caller asking for fresh PR state accepts instead of
 * reading the provider again, so an agent asking twice in a row spends one
 * read, not two.
 */
export const FRESH_ENOUGH_MS = 30_000;

/**
 * Reads the named workspaces' branches from their providers now and caches
 * what they say, for a caller that needs the current state rather than the
 * last poll. A repo polled since `freshSince` is left as it is. Like every
 * poll, this reads only active workspaces' ready repos. A repo it couldn't
 * read keeps its cached row: with the failure in `lastError`, or untouched
 * when a rate limit stopped the read first.
 */
export function refreshWorkspacePrs(
  db: Db,
  clients: PollerClients,
  workspaceIds: string[],
  freshSince: Date,
): Promise<void> {
  const wanted = new Set(workspaceIds);
  return pollOnce(db, clients, (candidate) =>
    wanted.has(candidate.workspaceId) &&
    (candidate.lastPolledAt === null || candidate.lastPolledAt < freshSince)
      ? "branch"
      : null,
  );
}

/** Refreshes every repo whose cached PR is due, as of `now`. */
export function pollDueRepos(db: Db, clients: PollerClients, now = Date.now()): Promise<void> {
  return pollOnce(db, clients, (candidate) => dueRefresh(candidate, now));
}

/**
 * Unsticks workspaces left in a transient state by an interrupted run: a
 * provision becomes `error`, along with its repos still mid-provision, and an
 * archive records that it needs retrying. Runs once at startup. Exported for
 * testing.
 */
export async function reconcileOrphans(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  // An interrupted archive stays in the archive flow, where the next step is
  // archiving again; as `error` it would offer to provision the worktrees back.
  // One that already stopped on an error isn't running, so it's left alone.
  const interruptedArchives = await db
    .update(workspaces)
    .set({ error: "archive interrupted; archive again to finish", updatedAt: new Date() })
    .where(
      and(
        eq(workspaces.status, "archiving"),
        isNull(workspaces.error),
        lt(workspaces.updatedAt, cutoff),
      ),
    )
    .returning({ id: workspaces.id });
  if (interruptedArchives.length) {
    console.warn(
      `[workspace poller] flagged ${interruptedArchives.length} interrupted archive(s) for retry`,
    );
  }

  const stuck = await db
    .update(workspaces)
    .set({ status: "error", error: "interrupted; retry provisioning", updatedAt: new Date() })
    .where(and(eq(workspaces.status, "creating"), lt(workspaces.updatedAt, cutoff)))
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
  const { githubToken, azureDevopsToken } = config.secrets;
  if (!config.databaseUrl || (!githubToken && !azureDevopsToken)) return () => {};
  const db = getDb(config.databaseUrl).db;
  const clients = pollerClients(config);

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap a slow cycle with the next
    running = true;
    try {
      await pollDueRepos(db, clients);
    } catch (e) {
      console.error("[workspace poller] cycle failed:", e);
    } finally {
      running = false;
    }
  };

  void reconcileOrphans(db)
    .catch((e) => console.error("[workspace poller] reconcile failed:", e))
    .finally(() => void tick());

  const timer = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(timer);
}
