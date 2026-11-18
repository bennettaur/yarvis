/**
 * Background poller that keeps each active workspace repo's PR + checks cache
 * (`workspace_repo_pr`) fresh from its provider. This is the app's only
 * background worker; it's started from `server.ts` after migrations. The UI
 * reads the cached rows (via `getWorkspace`) and never calls a provider on
 * render. A repo's provider is derived from its clone URL, so GitHub and Azure
 * DevOps repos are both refreshed in one cycle.
 *
 * A workspace repo can have many PRs: one per layer of a stack, several on one
 * branch over time, or ones linked by number. A cycle has two kinds of read.
 * Branch searches (the repo's own branch and those of worktrees an agent
 * added) find new PRs; they run on a fast timer only while their workspace is
 * on screen. Every known, unmerged PR is re-read by number on a slow timer
 * whether or not anyone is looking, so every badge stays current. GitHub reads
 * are batched GraphQL queries. The workspace routes record which reads the UI made.
 * Views are tracked in memory per sidecar process, so a named instance's UI
 * doesn't trigger polling in the main instance.
 */

import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { type AzureBranchPr, AzureDevOpsClient, isAllowedAzureOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import { type Db, getDb } from "../db/client.ts";
import {
  type Repo,
  repos,
  type WorkspaceRepoPr,
  workspaceExtraWorktrees,
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
import { clientError } from "../llm/errors.ts";
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

/**
 * What decides whether something is due a read: the workspace it belongs to
 * and when it was last read. A branch search has no PR number or state; a
 * known PR has both.
 */
export interface PollCandidate {
  workspaceId: string;
  prNumber: number | null;
  prState: string | null;
  lastPolledAt: Date | null;
}

/**
 * How a due candidate is read. `branch` searches a workspace repo's branches,
 * which is how a new PR is found; `number` re-reads a PR already known.
 */
export type RefreshMode = "branch" | "number";

/** A candidate read longer ago than this, measured from its last poll, is due. */
function dueAfter(candidate: PollCandidate, intervalMs: number, now: number): boolean {
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

/** How a candidate should be read this tick, or null when it isn't due. */
export function dueRefresh(candidate: PollCandidate, now = Date.now()): RefreshMode | null {
  const viewedAt = workspaceViewedAt.get(candidate.workspaceId);
  const focused = viewedAt !== undefined && now - viewedAt < VIEW_WINDOW_MS;
  const mode: RefreshMode = candidate.prNumber === null ? "branch" : "number";
  const settled = candidate.prState === "merged" || candidate.prState === "closed";
  // The workspace the user has open is searched and re-read every minute, so
  // a PR opened on it shows up quickly. A settled PR there has little left to change.
  if (focused) {
    return dueAfter(candidate, settled ? BACKGROUND_POLL_MS : FOCUSED_POLL_MS, now) ? mode : null;
  }
  // Every other known PR is re-read by number, whether or not anyone is
  // looking, so every badge stays current. A merged PR won't change again.
  if (candidate.prNumber !== null) {
    if (candidate.prState === "merged") return null;
    return windowTurned(candidate, now) ? "number" : null;
  }
  // Other workspaces' branches are only searched while their badges are on screen.
  const listVisible = now - listViewedAt < VIEW_WINDOW_MS;
  return listVisible && dueAfter(candidate, BACKGROUND_POLL_MS, now) ? "branch" : null;
}

/** Whether a candidate is older than its refresh interval. */
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

/** What the PR cache holds for one PR, minus the bookkeeping columns. */
export type BranchPr = Pick<
  WorkspaceRepoPr,
  | "prNumber"
  | "prUrl"
  | "prState"
  | "headSha"
  | "headBranch"
  | "isDraft"
  | "mergeable"
  | "checkRollup"
  | "checks"
  | "reviewDecision"
>;

/** A PR found on a branch: its cache values, and when it closed (null while open). */
export interface FoundPr extends BranchPr {
  closedAt: string | null;
}

/**
 * Writes one PR's cache row, adding it if the repo didn't have it yet. A PR
 * the user unlinked stays unlinked: `dismissed` is only cleared by a caller
 * that says so.
 */
async function upsertPr(
  db: Db,
  workspaceRepoId: string,
  values: BranchPr & Partial<typeof workspaceRepoPr.$inferInsert>,
): Promise<void> {
  const row = { ...values, workspaceRepoId, updatedAt: new Date() };
  await db
    .insert(workspaceRepoPr)
    .values(row)
    .onConflictDoUpdate({
      target: [workspaceRepoPr.workspaceRepoId, workspaceRepoPr.prNumber],
      set: row,
    });
}

/** The cache values for a GitHub PR the poller read. */
function toFoundPr(pr: PolledPr): FoundPr {
  return {
    prNumber: pr.number,
    prUrl: pr.url,
    prState: pr.status.merged ? "merged" : pr.status.state,
    headSha: pr.status.headSha,
    headBranch: pr.headBranch || null,
    isDraft: pr.draft,
    mergeable: pr.status.mergeableState,
    checkRollup: deriveRollup(pr.status.checks),
    checks: pr.status.checks,
    reviewDecision: pr.reviewDecision,
    closedAt: pr.closedAt,
  };
}

/** A GitHub PR's status and review verdict, read one PR at a time (REST-capable). */
async function githubPrStatus(
  gh: GitHubClient,
  owner: string,
  repo: string,
  summary: {
    number: number;
    url: string;
    draft: boolean;
    headRef?: string;
    closedAt?: string | null;
  },
): Promise<FoundPr> {
  const status = await gh.prStatus(owner, repo, summary.number);
  // The verdict costs an extra request, so only ask where it can change what
  // the user does next: a draft or an already-closed PR isn't waiting on review.
  // It is also the one enrichment here that a narrower token may not be allowed
  // to make, so a failure drops the verdict rather than the whole refresh —
  // otherwise a repo-scoped 403 would freeze that repo's check status and, read
  // as a rate limit by the caller, abandon the rest of the cycle.
  const awaitingReview = !status.merged && status.state === "open" && !summary.draft;
  const reviewDecision = awaitingReview
    ? await gh.prReviewDecision(owner, repo, summary.number).catch(() => null)
    : null;
  return toFoundPr({
    number: summary.number,
    url: summary.url,
    draft: summary.draft,
    headBranch: summary.headRef ?? "",
    closedAt: summary.closedAt ?? null,
    status,
    reviewDecision,
  });
}

/**
 * The PRs on one GitHub branch and where their checks stand, read one at a
 * time so each read can fall back to REST. Backs the worktree PR lookup, and
 * the poller's branch searches when GraphQL can't run its batched read.
 */
async function githubBranchPrs(
  gh: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<FoundPr[]> {
  const found: FoundPr[] = [];
  for (const pr of await gh.findPrsByBranch(owner, repo, branch)) {
    found.push(await githubPrStatus(gh, owner, repo, { ...pr, headRef: pr.headRef ?? branch }));
  }
  return found;
}

/** An Azure DevOps PR with where its CI policies stand, as the cache holds it. */
async function azurePolledPr(
  az: AzureDevOpsClient,
  project: string,
  pr: AzureBranchPr,
): Promise<FoundPr> {
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
    headSha: pr.headSha,
    headBranch: pr.headBranch || null,
    isDraft: pr.draft,
    mergeable: pr.mergeable,
    checkRollup: checks ? deriveRollup(checks) : "none",
    checks,
    reviewDecision: awaitingReview ? pr.reviewDecision : null,
    closedAt: pr.closedAt,
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

/** The Azure DevOps client that can read `repo`, or null for a repo on another org or provider. */
function azureFor(
  clients: PollerClients,
  repo: Repo,
): { az: AzureDevOpsClient; project: string; repo: string } | null {
  const remote = parseRepoRemote(repo.cloneUrl);
  if (remote?.provider !== "azure" || !clients.azure) return null;
  // A lookup on an org other than the configured one would only 404.
  if (clients.azure.org.toLowerCase() !== remote.org.toLowerCase()) return null;
  return { az: clients.azure, project: remote.project, repo: remote.repo };
}

const isAzureRepo = (repo: Repo) => parseRepoRemote(repo.cloneUrl)?.provider === "azure";

/**
 * The PRs on one of a repo's branches, newest first, from whichever provider
 * its clone URL names. Null when no client can reach that provider.
 */
async function branchPrs(
  clients: PollerClients,
  repo: Repo,
  branch: string,
): Promise<FoundPr[] | null> {
  if (isAzureRepo(repo)) {
    const azure = azureFor(clients, repo);
    if (!azure) return null;
    const prs = await azure.az.findPrsByBranch(azure.project, azure.repo, branch);
    const found: FoundPr[] = [];
    for (const pr of prs) found.push(await azurePolledPr(azure.az, azure.project, pr));
    return found;
  }
  if (!clients.github) return null;
  const { owner, repo: repoName } = githubRepoOf(repo);
  return githubBranchPrs(clients.github, owner, repoName, branch);
}

/**
 * One of a repo's PRs, read by number from whichever provider its clone URL
 * names. Null when no client can reach that provider. Throws when the provider
 * has no such PR.
 */
async function numberPr(
  clients: PollerClients,
  repo: Repo,
  number: number,
): Promise<FoundPr | null> {
  if (isAzureRepo(repo)) {
    const azure = azureFor(clients, repo);
    if (!azure) return null;
    const pr = await azure.az.branchPrById({
      project: azure.project,
      repo: azure.repo,
      prId: number,
    });
    return azurePolledPr(azure.az, azure.project, pr);
  }
  if (!clients.github) return null;
  const [result] = await clients.github.prStatusesByNumber([{ ...githubRepoOf(repo), number }]);
  if (!result) return null;
  if (!result.ok) throw result.error;
  return toFoundPr(result.value);
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
 * The newest PR on a branch, read when the user asks rather than cached, for
 * the right column's view of one worktree. Null when no configured provider
 * can answer for this repo; `prNumber` is null when the branch has no PR.
 */
export async function lookupBranchPr(
  config: Config,
  repo: Repo,
  branch: string,
): Promise<(Omit<BranchPr, "prNumber"> & { prNumber: number | null }) | null> {
  const prs = await branchPrs(pollerClients(config), repo, branch);
  if (prs === null) return null;
  const [newest] = prs;
  if (newest) {
    const { closedAt: _closedAt, ...pr } = newest;
    return pr;
  }
  return {
    prNumber: null,
    prUrl: null,
    prState: null,
    headSha: null,
    headBranch: null,
    isDraft: null,
    mergeable: null,
    checkRollup: "none",
    checks: null,
    reviewDecision: null,
  };
}

/** Whether a failure means the provider's rate limit is spent, so the rest of the cycle should wait. */
function isRateLimited(e: unknown): boolean {
  // GitHub's errors name the reason; Azure's only carry the status, where 403
  // (secondary) and 429 mean a limit and 409 (Conflict) is unrelated.
  if (e instanceof GitHubError) return e.reason === "rate_limited";
  return /-> (403|429)$/.test(e instanceof Error ? e.message : String(e));
}

/** Whether a failure means the provider has no such PR or repo. */
function isNotFound(e: unknown): boolean {
  // Azure's errors carry only the status, at the end of the message.
  if (e instanceof GitHubError) return e.reason === "not_found";
  return /-> 404$/.test(e instanceof Error ? e.message : String(e));
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
 * A workspace repo whose branches are searched for PRs: its own branch and
 * those of the worktrees an agent added, each with when it joined the
 * workspace.
 */
interface SearchTarget {
  wr: typeof workspaceRepos.$inferSelect;
  repo: Repo;
  branches: { branch: string; since: Date }[];
}

/** A known PR re-read by number. */
interface KnownPr {
  wr: typeof workspaceRepos.$inferSelect;
  repo: Repo;
  prNumber: number;
}

/**
 * Whether a PR found on a branch belongs to this workspace. An open PR always
 * does. One that closed or merged before its branch joined the workspace is an
 * earlier use of the same branch name, not this work.
 */
function belongsToWorkspace(pr: FoundPr, since: Date): boolean {
  return pr.closedAt === null || new Date(pr.closedAt).getTime() >= since.getTime();
}

/**
 * Stores what a search of one repo's branches found. A PR on two of its
 * branches is stored once. The search time is recorded even when nothing was
 * found, which is how "no PR yet" differs from "not looked".
 */
async function recordSearch(
  db: Db,
  target: SearchTarget,
  found: { pr: FoundPr; since: Date }[],
  error: unknown,
): Promise<FoundPr[]> {
  const kept = new Map<number, FoundPr>();
  for (const { pr, since } of found) {
    if (pr.prNumber !== null && belongsToWorkspace(pr, since) && !kept.has(pr.prNumber)) {
      kept.set(pr.prNumber, pr);
    }
  }
  const now = new Date();
  for (const { closedAt: _closedAt, ...pr } of kept.values()) {
    await upsertPr(db, target.wr.id, { ...pr, lastPolledAt: now, lastError: null });
  }
  await db
    .update(workspaceRepos)
    .set({ prsPolledAt: now, prsPollError: error === null ? null : clientError(error) })
    .where(eq(workspaceRepos.id, target.wr.id));
  return [...kept.values()];
}

/** Caches why a known PR's read failed, and when, so it waits its interval before the next try. */
async function recordPrError(db: Db, known: KnownPr, e: unknown): Promise<void> {
  await db
    .update(workspaceRepoPr)
    .set({ lastPolledAt: new Date(), lastError: clientError(e), updatedAt: new Date() })
    .where(
      and(
        eq(workspaceRepoPr.workspaceRepoId, known.wr.id),
        eq(workspaceRepoPr.prNumber, known.prNumber),
      ),
    );
}

/**
 * Searches each target's branches one at a time, stopping at the first rate
 * limit. Returns what each searched target found, by workspace repo id.
 */
async function searchEach(
  db: Db,
  clients: PollerClients,
  targets: SearchTarget[],
): Promise<{ results: Map<string, FoundPr[]>; finished: boolean }> {
  const results = new Map<string, FoundPr[]>();
  for (const target of targets) {
    const found: { pr: FoundPr; since: Date }[] = [];
    let error: unknown = null;
    let readable = true;
    for (const { branch, since } of target.branches) {
      try {
        const prs = await branchPrs(clients, target.repo, branch);
        if (prs === null) {
          readable = false;
          break;
        }
        for (const pr of prs) found.push({ pr, since });
      } catch (e) {
        // One branch's failure is recorded on the repo; the others still count.
        error = e;
        if (isRateLimited(e)) {
          await recordSearch(db, target, found, e);
          console.warn("[workspace poller] rate limited, backing off this cycle");
          return { results, finished: false };
        }
      }
    }
    if (!readable) continue;
    results.set(target.wr.id, await recordSearch(db, target, found, error));
  }
  return { results, finished: true };
}

/**
 * Searches GitHub targets' branches in batched reads, one alias per branch.
 * Each batch is stored as soon as it's read. A batch GraphQL can't answer at
 * all (an outage, or a GitHub Enterprise server that can't run the batch) is
 * searched one branch at a time instead, which can use REST; a spent rate
 * limit ends the cycle.
 */
async function searchGithub(
  db: Db,
  clients: PollerClients,
  gh: GitHubClient,
  targets: SearchTarget[],
): Promise<boolean> {
  // Batched by branch, but stored by repo, so a repo's branches stay in one batch.
  const batches: SearchTarget[][] = [[]];
  let size = 0;
  for (const target of targets) {
    if (size + target.branches.length > POLL_BATCH_SIZE && size > 0) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1)?.push(target);
    size += target.branches.length;
  }
  for (const batch of batches) {
    if (batch.length === 0) continue;
    const refs = batch.flatMap((t) =>
      t.branches.map((b) => ({ ...githubRepoOf(t.repo), branch: b.branch })),
    );
    let results: BatchResult<PolledPr[]>[];
    try {
      results = await gh.branchPrStatuses(refs);
    } catch (e) {
      if (isRateLimited(e)) {
        // No REST fallback here: a background read waits out GraphQL's limit
        // rather than spending the REST budget the PR pages need.
        console.warn("[workspace poller] GitHub rate limited, backing off this cycle");
        return false;
      }
      if (e instanceof GitHubError && e.reason === "upstream_error") {
        const { finished } = await searchEach(db, clients, batch);
        if (!finished) return false;
        continue;
      }
      // Anything else (a revoked token, SSO) is every repo's answer.
      for (const target of batch) await recordSearch(db, target, [], e);
      continue;
    }
    let i = 0;
    for (const target of batch) {
      const found: { pr: FoundPr; since: Date }[] = [];
      let error: unknown = null;
      for (const { since } of target.branches) {
        const result = results[i++];
        if (!result) continue;
        if (result.ok) for (const pr of result.value) found.push({ pr: toFoundPr(pr), since });
        else error = result.error;
      }
      await recordSearch(db, target, found, error);
    }
  }
  return true;
}

/** Re-reads known GitHub PRs by number in batched reads, storing each batch as it's read. */
async function refreshGithubByNumber(db: Db, gh: GitHubClient, known: KnownPr[]): Promise<void> {
  for (const items of inBatches(known)) {
    let results: BatchResult<PolledPr>[];
    try {
      results = await gh.prStatusesByNumber(
        items.map((k) => ({ ...githubRepoOf(k.repo), number: k.prNumber })),
      );
    } catch (e) {
      if (isRateLimited(e)) {
        console.warn("[workspace poller] GitHub rate limited, backing off this cycle");
        return;
      }
      // An outage leaves known PRs for the next window; nobody is waiting on them.
      for (const item of items) await recordPrError(db, item, e);
      continue;
    }
    for (const [i, result] of results.entries()) {
      const item = items[i] as KnownPr;
      if (result.ok) {
        const { closedAt: _closedAt, ...pr } = toFoundPr(result.value);
        await upsertPr(db, item.wr.id, { ...pr, lastPolledAt: new Date(), lastError: null });
      } else {
        await recordPrError(db, item, result.error);
      }
    }
  }
}

/** Re-reads known Azure DevOps PRs one at a time, stopping at the first rate limit. */
async function refreshAzureByNumber(
  db: Db,
  clients: PollerClients,
  known: KnownPr[],
): Promise<void> {
  for (const item of known) {
    try {
      const found = await numberPr(clients, item.repo, item.prNumber);
      if (!found) continue;
      const { closedAt: _closedAt, ...pr } = found;
      await upsertPr(db, item.wr.id, { ...pr, lastPolledAt: new Date(), lastError: null });
    } catch (e) {
      await recordPrError(db, item, e);
      if (isRateLimited(e)) {
        console.warn("[workspace poller] Azure DevOps rate limited, backing off this cycle");
        return;
      }
    }
  }
}

/** The ready repos of active workspaces, with the branches of their added worktrees. */
async function searchCandidates(db: Db, workspaceIds?: string[]) {
  const conditions = [eq(workspaces.status, "active"), eq(workspaceRepos.status, "ready")];
  if (workspaceIds) conditions.push(inArray(workspaces.id, workspaceIds));
  const rows = await db
    .select({ wr: workspaceRepos, repo: repos })
    .from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(...conditions));
  if (!rows.length) return [];
  const extras = await db
    .select()
    .from(workspaceExtraWorktrees)
    .where(
      inArray(
        workspaceExtraWorktrees.workspaceRepoId,
        rows.map((r) => r.wr.id),
      ),
    )
    .orderBy(desc(workspaceExtraWorktrees.createdAt));
  return rows.map(({ wr, repo }): SearchTarget => {
    const branches = [{ branch: wr.branch, since: wr.createdAt }];
    for (const extra of extras) {
      if (extra.workspaceRepoId !== wr.id) continue;
      if (branches.some((b) => b.branch === extra.branch)) continue;
      branches.push({ branch: extra.branch, since: extra.createdAt });
    }
    return { wr, repo, branches };
  });
}

/** The PRs linked to active workspaces' ready repos, minus the ones the user unlinked. */
async function knownPrCandidates(db: Db, workspaceIds?: string[]) {
  const conditions = [
    eq(workspaces.status, "active"),
    eq(workspaceRepos.status, "ready"),
    eq(workspaceRepoPr.dismissed, false),
  ];
  if (workspaceIds) conditions.push(inArray(workspaces.id, workspaceIds));
  return db
    .select({ wr: workspaceRepos, repo: repos, pr: workspaceRepoPr })
    .from(workspaceRepoPr)
    .innerJoin(workspaceRepos, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(...conditions));
}

/**
 * One poll cycle: searches the branches of every repo `modeFor` names a read
 * for (which finds new PRs and refreshes the ones on those branches), then
 * re-reads by number every known PR it names that the search didn't just read.
 * A search runs only for "branch"; a known PR is read by number for either
 * mode, so a caller can ask for number reads alone. Both are
 * limited to active workspaces' ready repos. Each provider has its own rate
 * limit, so one running out doesn't hold up the other.
 */
export async function pollOnce(
  db: Db,
  clients: PollerClients,
  modeFor: (candidate: PollCandidate) => RefreshMode | null = () => "branch",
  workspaceIds?: string[],
): Promise<void> {
  const cycleStart = new Date();
  const targets = (await searchCandidates(db, workspaceIds)).filter(
    (t) =>
      modeFor({
        workspaceId: t.wr.workspaceId,
        prNumber: null,
        prState: null,
        lastPolledAt: t.wr.prsPolledAt,
      }) === "branch",
  );
  const githubTargets = targets.filter((t) => !isAzureRepo(t.repo));
  const azureTargets = targets.filter((t) => isAzureRepo(t.repo));
  // A spent GitHub limit ends this cycle's GitHub reads, number reads included.
  let githubLimited = false;
  if (clients.github && githubTargets.length) {
    githubLimited = !(await searchGithub(db, clients, clients.github, githubTargets));
  }
  if (azureTargets.length) await searchEach(db, clients, azureTargets);

  // Read after the searches, so a PR a search just refreshed isn't read twice.
  const known = (await knownPrCandidates(db, workspaceIds))
    .filter(
      ({ wr, pr }) =>
        !(pr.lastPolledAt && pr.lastPolledAt >= cycleStart) &&
        modeFor({
          workspaceId: wr.workspaceId,
          prNumber: pr.prNumber,
          prState: pr.prState,
          lastPolledAt: pr.lastPolledAt,
        }) !== null,
    )
    .map(({ wr, repo, pr }): KnownPr => ({ wr, repo, prNumber: pr.prNumber }));
  const githubKnown = known.filter((k) => !isAzureRepo(k.repo));
  const azureKnown = known.filter((k) => isAzureRepo(k.repo));
  if (clients.github && githubKnown.length && !githubLimited) {
    await refreshGithubByNumber(db, clients.github, githubKnown);
  }
  if (azureKnown.length) await refreshAzureByNumber(db, clients, azureKnown);
}

/**
 * How recent a poll a caller asking for fresh PR state accepts instead of
 * reading the provider again, so an agent asking twice in a row spends one
 * read, not two.
 */
export const FRESH_ENOUGH_MS = 30_000;

/**
 * Searches the named workspaces' branches and re-reads their known PRs now,
 * for a caller that needs the current state rather than the last poll.
 * Anything read since `freshSince` is left as it is. Like every poll, this
 * reads only active workspaces' ready repos. Whatever couldn't be read keeps
 * its cached state: with the failure in `lastError` (or `prsPollError`), or
 * untouched when a rate limit stopped the read first.
 */
export function refreshWorkspacePrs(
  db: Db,
  clients: PollerClients,
  workspaceIds: string[],
  freshSince: Date,
): Promise<void> {
  if (workspaceIds.length === 0) return Promise.resolve();
  return pollOnce(
    db,
    clients,
    (candidate) =>
      candidate.lastPolledAt === null || candidate.lastPolledAt < freshSince ? "branch" : null,
    workspaceIds,
  );
}

/** Refreshes everything that is due, as of `now`. */
export function pollDueRepos(db: Db, clients: PollerClients, now = Date.now()): Promise<void> {
  return pollOnce(db, clients, (candidate) => dueRefresh(candidate, now));
}

/** GraphQL's `Int` is 32-bit, so a larger PR number can only fail at the provider. */
export const MAX_PR_NUMBER = 2_147_483_647;

/** A request to link or detect a PR that can't be met, as opposed to a provider failure. */
export class PrLinkRefusal extends Error {}

/** A workspace repo and its registered repo, checked to belong to `workspaceId`. */
async function workspaceRepoIn(
  db: Db,
  workspaceId: string,
  workspaceRepoId: string,
): Promise<{ wr: typeof workspaceRepos.$inferSelect; repo: Repo }> {
  const [row] = await db
    .select({ wr: workspaceRepos, repo: repos, status: workspaces.status })
    .from(workspaceRepos)
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(
      and(eq(workspaceRepos.id, workspaceRepoId), eq(workspaceRepos.workspaceId, workspaceId)),
    );
  if (!row) throw new PrLinkRefusal("that repo is not part of this workspace");
  if (row.status === "archived") throw new PrLinkRefusal("the workspace is archived");
  return { wr: row.wr, repo: row.repo };
}

/**
 * Links a PR to a workspace made for it, before anything has read the PR. The
 * row is left unpolled so the next tick reads the rest. Linking it again
 * undoes an earlier unlink.
 */
export async function seedWorkspacePr(
  db: Db,
  workspaceRepoId: string,
  number: number,
  headBranch: string,
): Promise<void> {
  await db
    .insert(workspaceRepoPr)
    .values({ workspaceRepoId, prNumber: number, headBranch })
    .onConflictDoUpdate({
      target: [workspaceRepoPr.workspaceRepoId, workspaceRepoPr.prNumber],
      set: { dismissed: false, updatedAt: new Date() },
    });
}

/**
 * Links one of a workspace repo's PRs by number, beside any it already has.
 * Reads the PR first, so a number the provider doesn't know is refused rather
 * than stored. Undoes an earlier unlink of the same PR.
 */
export async function linkWorkspacePr(
  db: Db,
  clients: PollerClients,
  workspaceId: string,
  workspaceRepoId: string,
  number: number,
): Promise<BranchPr> {
  const { wr, repo } = await workspaceRepoIn(db, workspaceId, workspaceRepoId);
  let found: FoundPr | null;
  try {
    found = await numberPr(clients, repo, number);
  } catch (e) {
    if (isNotFound(e)) throw new PrLinkRefusal(`${repo.name} has no pull request #${number}`);
    throw e;
  }
  if (!found) {
    throw new PrLinkRefusal(
      `no GitHub or Azure DevOps token can read ${repo.name}'s pull requests`,
    );
  }
  const { closedAt: _closedAt, ...pr } = found;
  await upsertPr(db, wr.id, { ...pr, dismissed: false, lastPolledAt: new Date(), lastError: null });
  return pr;
}

/**
 * Unlinks one of a workspace repo's PRs. The row is kept, marked dismissed, so
 * the next search of its branch doesn't add it back.
 */
export async function unlinkWorkspacePr(
  db: Db,
  workspaceId: string,
  workspaceRepoId: string,
  number: number,
): Promise<void> {
  const { wr } = await workspaceRepoIn(db, workspaceId, workspaceRepoId);
  const unlinked = await db
    .update(workspaceRepoPr)
    .set({ dismissed: true, updatedAt: new Date() })
    .where(and(eq(workspaceRepoPr.workspaceRepoId, wr.id), eq(workspaceRepoPr.prNumber, number)))
    .returning({ id: workspaceRepoPr.id });
  if (!unlinked.length) throw new PrLinkRefusal(`#${number} is not linked to this repo`);
}

/** What a detection search found for one repo in a workspace. */
export interface DetectedPrs {
  workspaceRepoId: string;
  /** Every PR the search found on the repo's branches, the unlinked ones included. */
  prs: { number: number; url: string | null; branch: string | null }[];
}

/**
 * Searches every branch of the workspace's repos now, rather than on the
 * poller's schedule, and adds each PR found. It never removes a PR: one the
 * user unlinked stays unlinked. A repo no configured provider can read is left
 * out; one whose search failed records why in `prsPollError`.
 */
export async function detectWorkspacePrs(
  db: Db,
  clients: PollerClients,
  workspaceId: string,
): Promise<DetectedPrs[]> {
  const [workspace] = await db
    .select({ status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new PrLinkRefusal("workspace not found");
  if (workspace.status === "archived") throw new PrLinkRefusal("the workspace is archived");
  // Searched one branch at a time so each read can fall back to REST, and so
  // the answer says which repo found what.
  const targets = await searchCandidates(db, [workspaceId]);
  const { results } = await searchEach(db, clients, targets);
  return [...results.entries()].map(([workspaceRepoId, prs]) => ({
    workspaceRepoId,
    prs: prs.map((pr) => ({
      number: pr.prNumber as number,
      url: pr.prUrl,
      branch: pr.headBranch,
    })),
  }));
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
