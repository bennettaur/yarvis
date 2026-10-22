/**
 * Review workspaces: named sets of pull requests, each checked out in its own
 * detached worktree so the review UI can read the whole tree, diff any file and
 * point tools at real files.
 *
 * Disk layout, all under the workspaces root:
 *   .review-repos/<provider>/<owner…>/<repo>   one blobless clone per repo
 *   .review/<workspace id>/<refDomKey>         one detached worktree per PR
 * The clone is never a coding workspace's clone, even when the repo is
 * registered, so review traffic can't move anything someone is working in.
 *
 * A sync (clone or refresh) runs in the background (see `progress.ts`). A PR is
 * `ready` — reviewable — as soon as its shas are fetched, since every read
 * comes from git objects; the changed blobs are then downloaded in one batch
 * and the worktree checked out, tracked by `worktreeStatus`, which only setup
 * and code navigation wait on.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, asc, desc, eq, getTableColumns, inArray, ne } from "drizzle-orm";
import { isAllowedAzureOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type ReviewWorkspace,
  type ReviewWorkspacePr,
  reviewWorkspacePrs,
  reviewWorkspaces,
} from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { prSourceFor } from "../pr/source.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { runSetupScript } from "../workspaces/exec.ts";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { removeWorktree } from "../workspaces/git.ts";
import {
  assertSafeBranchName,
  findRepoForPr,
  isSafePathSegment,
  isUniqueViolation,
  type PrLocator,
} from "../workspaces/service.ts";
import { ShaCache, stringsSize } from "./cache.ts";
import {
  type ChangedFileWithSizes,
  changedFilesBetween,
  checkoutWorktree,
  credentialEnv,
  ensureReviewClone,
  type FileAtSide,
  fetchPr,
  fileDiffBetween,
  type HeadSource,
  type PrShas,
  type ReviewChangedFile,
  type ReviewGit,
  readFileAt,
  registerWorktree,
  reviewGit,
  treePaths,
} from "./git.ts";
import {
  claimRun,
  forgetRuns,
  isRunning,
  type ReviewRunPhase,
  type RunHandle,
  startRun,
  whenIdle,
} from "./progress.ts";

/** A refusal with the HTTP status the route should answer with. */
export class ReviewWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "ReviewWorkspaceError";
  }
}

type SyncPhase = Exclude<ReviewRunPhase, "setup">;

// ---------------------------------------------------------------------------
// Dependencies on the outside world, injectable for tests
// ---------------------------------------------------------------------------

/** What a review needs to know about a PR from its provider. */
export interface PrMeta {
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  fromFork: boolean;
}

/** Where to fetch a PR's repo from, and the environment that authenticates it. */
interface PrRemote {
  url: string;
  env: Record<string, string>;
}

export interface ReviewDeps {
  loadPr(ref: PrRef): Promise<PrMeta>;
  remoteFor(ref: PrRef): Promise<PrRemote>;
  /** The registered repo's setup script for this PR's repo, if there is one. */
  setupScriptFor(ref: PrRef): Promise<string | null>;
  git(env: Record<string, string>): ReviewGit;
}

function locatorFor(ref: PrRef): PrLocator {
  return ref.provider === "github"
    ? { provider: "github", owner: ref.owner, repo: ref.repo, number: ref.number }
    : { provider: "azure", org: ref.org, project: ref.project, repo: ref.repo, number: ref.prId };
}

function prNumber(ref: PrRef): number {
  return ref.provider === "github" ? ref.number : ref.prId;
}

/**
 * The https remote for a PR's repo, used when the repo isn't registered.
 * GitHub's host is fixed; Azure's comes from the configured organization URL,
 * which is checked to be an Azure DevOps host before a token is sent to it.
 */
function httpsRemoteFor(
  config: Pick<Config, "secrets">,
  ref: PrRef,
): { url: string; host: string; username: string; token: string | undefined } {
  if (ref.provider === "github") {
    return {
      url: `https://github.com/${ref.owner}/${ref.repo}.git`,
      host: "github.com",
      username: "x-access-token",
      token: config.secrets.githubToken,
    };
  }
  const orgUrl = config.secrets.azureDevopsOrgUrl;
  if (!orgUrl || !isAllowedAzureOrgUrl(orgUrl)) {
    throw new ReviewWorkspaceError("azure devops is not configured", 400);
  }
  const base = orgUrl.replace(/\/+$/, "");
  return {
    url: `${base}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}`,
    host: new URL(base).hostname,
    username: "yarvis",
    token: config.secrets.azureDevopsToken,
  };
}

/**
 * The real dependencies. A registered repo's clone URL wins — usually ssh,
 * authenticated by the user's agent the way coding workspaces are — and an
 * unregistered one is fetched over https. Either way the provider token rides
 * along through {@link credentialEnv}, which only answers an https request to
 * the provider's own host, so it is unused (and harmless) on an ssh remote.
 */
export function defaultReviewDeps(db: Db, config: Config): ReviewDeps {
  return {
    async loadPr(ref) {
      const source = prSourceFor(config, ref);
      if ("error" in source) throw new ReviewWorkspaceError(source.error, 400);
      const detail = await source.detail();
      return {
        title: detail.title,
        author: detail.author,
        headRef: detail.headRef,
        baseRef: detail.baseRef,
        fromFork: detail.fromFork,
      };
    },
    async remoteFor(ref) {
      const https = httpsRemoteFor(config, ref);
      const registered = await findRepoForPr(db, locatorFor(ref));
      return {
        url: registered?.cloneUrl ?? https.url,
        env: https.token ? credentialEnv(https.host, https.username, https.token) : {},
      };
    },
    async setupScriptFor(ref) {
      const registered = await findRepoForPr(db, locatorFor(ref));
      return registered?.setupScript?.trim() ? registered.setupScript : null;
    },
    git: reviewGit,
  };
}

/**
 * Each PR's remote, resolved when it syncs. Finding it means scanning the
 * registered repos, which a read shouldn't pay for on every request; after a
 * restart the first read resolves it once and keeps it.
 */
const remotes = new Map<string, PrRemote>();

async function remoteForPr(pr: ReviewWorkspacePr, deps: ReviewDeps): Promise<PrRemote> {
  const known = remotes.get(pr.id);
  if (known) return known;
  const remote = await deps.remoteFor(pr.ref);
  remotes.set(pr.id, remote);
  return remote;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The clone for a PR's repo. One folder per identity segment rather than a
 * joined name, since `a-b/c` and `a/b-c` would otherwise share a folder.
 * Lower-cased because both providers treat these names case-insensitively.
 */
function reviewClonePath(config: Pick<Config, "workspacesRoot">, ref: PrRef): string {
  const segments =
    ref.provider === "github"
      ? ["github", ref.owner, ref.repo]
      : ["azure", ref.org, ref.project, ref.repo];
  const lowered = segments.map((s) => s.toLowerCase());
  if (!lowered.every(isSafePathSegment)) {
    throw new ReviewWorkspaceError(`unsafe repository name in ${refKey(ref)}`, 400);
  }
  return join(config.workspacesRoot, ".review-repos", ...lowered);
}

/** The folder holding one review workspace's worktrees. */
function reviewWorkspaceDir(config: Pick<Config, "workspacesRoot">, id: string): string {
  return join(config.workspacesRoot, ".review", id);
}

/** A DOM-id-safe variant of `refKey`, matching the frontend's `refDomKey`. */
function refDomKey(ref: PrRef): string {
  return refKey(ref).replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Throws unless the PR's worktree path sits directly in its workspace's folder.
 * Checked before anything is checked out there or deleted from there, so a row
 * that somehow named another path can't point either at the rest of the disk.
 */
function assertWorktreeInWorkspace(config: Config, pr: ReviewWorkspacePr): void {
  if (dirname(resolve(pr.worktreePath)) !== resolve(reviewWorkspaceDir(config, pr.workspaceId))) {
    throw new Error(`${pr.worktreePath} is not in this review workspace's folder; left in place`);
  }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

interface ReviewWorkspaceDetail extends ReviewWorkspace {
  prs: ReviewWorkspacePr[];
}

/** A PR as the workspace list shows it: the setup log is only read on demand. */
type ReviewWorkspacePrSummary = Omit<ReviewWorkspacePr, "setupLog">;

async function prsFor(db: Db, workspaceId: string): Promise<ReviewWorkspacePr[]> {
  return db
    .select()
    .from(reviewWorkspacePrs)
    .where(eq(reviewWorkspacePrs.workspaceId, workspaceId))
    .orderBy(asc(reviewWorkspacePrs.position));
}

export async function listReviewWorkspaces(
  db: Db,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<(ReviewWorkspace & { prs: ReviewWorkspacePrSummary[] })[]> {
  const rows = await db
    .select()
    .from(reviewWorkspaces)
    .where(includeArchived ? undefined : ne(reviewWorkspaces.status, "archived"))
    .orderBy(desc(reviewWorkspaces.lastOpenedAt), desc(reviewWorkspaces.createdAt));
  if (rows.length === 0) return [];
  const { setupLog: _omitted, ...summaryColumns } = getTableColumns(reviewWorkspacePrs);
  const prs = await db
    .select(summaryColumns)
    .from(reviewWorkspacePrs)
    .where(
      inArray(
        reviewWorkspacePrs.workspaceId,
        rows.map((ws) => ws.id),
      ),
    )
    .orderBy(asc(reviewWorkspacePrs.position));
  const byWorkspace = new Map<string, ReviewWorkspacePrSummary[]>();
  for (const pr of prs) {
    const list = byWorkspace.get(pr.workspaceId) ?? [];
    list.push(pr);
    byWorkspace.set(pr.workspaceId, list);
  }
  return rows.map((ws) => ({ ...ws, prs: byWorkspace.get(ws.id) ?? [] }));
}

export async function getReviewWorkspace(
  db: Db,
  id: string,
): Promise<ReviewWorkspaceDetail | null> {
  const [ws] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, id));
  if (!ws) return null;
  return { ...ws, prs: await prsFor(db, id) };
}

async function requireWorkspace(db: Db, id: string): Promise<ReviewWorkspaceDetail> {
  const ws = await getReviewWorkspace(db, id);
  if (!ws) throw new ReviewWorkspaceError("review workspace not found", 404);
  return ws;
}

/** Creates a workspace and starts cloning any PRs it was created with. */
export async function createReviewWorkspace(
  db: Db,
  config: Config,
  input: { name: string; refs?: PrRef[] },
  deps: ReviewDeps,
): Promise<ReviewWorkspaceDetail> {
  // Path checks first, so a bad ref refuses the whole request instead of
  // leaving a workspace holding half of what was asked for.
  for (const ref of input.refs ?? []) reviewClonePath(config, ref);
  const [ws] = await db.insert(reviewWorkspaces).values({ name: input.name }).returning();
  if (!ws) throw new Error("failed to create review workspace");
  const seen = new Set<string>();
  for (const ref of input.refs ?? []) {
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    await addReviewPr(db, config, ws.id, ref, deps);
  }
  return requireWorkspace(db, ws.id);
}

export async function renameReviewWorkspace(
  db: Db,
  id: string,
  name: string,
): Promise<ReviewWorkspaceDetail | null> {
  const [row] = await db
    .update(reviewWorkspaces)
    .set({ name, updatedAt: new Date() })
    .where(eq(reviewWorkspaces.id, id))
    .returning();
  return row ? getReviewWorkspace(db, id) : null;
}

/** Records that the workspace was opened, which orders the list. */
export async function touchReviewWorkspace(
  db: Db,
  id: string,
): Promise<ReviewWorkspaceDetail | null> {
  const [row] = await db
    .update(reviewWorkspaces)
    .set({ lastOpenedAt: new Date() })
    .where(eq(reviewWorkspaces.id, id))
    .returning();
  return row ? getReviewWorkspace(db, id) : null;
}

async function requireActiveWorkspace(db: Db, id: string): Promise<ReviewWorkspace> {
  const [ws] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, id));
  if (!ws) throw new ReviewWorkspaceError("review workspace not found", 404);
  if (ws.status !== "active") {
    throw new ReviewWorkspaceError(`review workspace is ${ws.status}`, 409);
  }
  return ws;
}

// ---------------------------------------------------------------------------
// PRs
// ---------------------------------------------------------------------------

/** The lowest colour index not already taken, so a removed PR's colour is reused. */
function lowestUnusedColorIndex(taken: Iterable<number>): number {
  const used = new Set(taken);
  let index = 0;
  while (used.has(index)) index++;
  return index;
}

/**
 * Adds a PR to a workspace and starts cloning it in the background. Answers
 * with the row as soon as it exists; `GET …/progress` follows the clone.
 */
export async function addReviewPr(
  db: Db,
  config: Config,
  workspaceId: string,
  ref: PrRef,
  deps: ReviewDeps,
): Promise<ReviewWorkspacePr> {
  await requireActiveWorkspace(db, workspaceId);
  reviewClonePath(config, ref);
  const existing = await prsFor(db, workspaceId);
  const key = refKey(ref);
  const duplicate = new ReviewWorkspaceError("this pull request is already in the workspace", 409);
  if (existing.some((pr) => pr.refKey === key)) throw duplicate;

  const id = randomUUID();
  // Two refs can flatten to the same folder name (`a-b/c` and `a/b-c`); the
  // second one gets the row id on the end rather than sharing a checkout.
  let worktreePath = join(reviewWorkspaceDir(config, workspaceId), refDomKey(ref));
  if (existing.some((pr) => pr.worktreePath === worktreePath)) {
    worktreePath = `${worktreePath}-${id.slice(0, 8)}`;
  }

  let row: ReviewWorkspacePr | undefined;
  try {
    [row] = await db
      .insert(reviewWorkspacePrs)
      .values({
        id,
        workspaceId,
        refKey: key,
        ref,
        colorIndex: lowestUnusedColorIndex(existing.map((pr) => pr.colorIndex)),
        position: existing.reduce((max, pr) => Math.max(max, pr.position + 1), 0),
        worktreePath,
      })
      .returning();
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate;
    throw e;
  }
  if (!row) throw new Error("failed to add pull request");
  startSync(db, config, row, "clone", deps);
  return row;
}

export async function getReviewPr(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<ReviewWorkspacePr> {
  const [row] = await db
    .select()
    .from(reviewWorkspacePrs)
    .where(and(eq(reviewWorkspacePrs.id, prId), eq(reviewWorkspacePrs.workspaceId, workspaceId)));
  if (!row) throw new ReviewWorkspaceError("pull request not found", 404);
  return row;
}

/**
 * Serializes what changes a review clone's refs or worktree list: clone, fetch,
 * and registering a worktree. Checkouts and reads don't hold it, so one PR's
 * slow checkout never queues another PR's fetch behind it.
 */
const withCloneLock = createKeyedLock();

/** Where a PR's head commit is fetched from. */
function headSourceFor(ref: PrRef, meta: Pick<PrMeta, "headRef" | "fromFork">): HeadSource {
  if (ref.provider === "github") return { kind: "ref", ref: `refs/pull/${ref.number}/head` };
  // Azure publishes no head ref for a PR, only the merge preview; the source
  // commit is its second parent. A same-repo branch is fetched directly, since
  // the merge preview is missing while the PR has conflicts.
  if (meta.fromFork) return { kind: "merge-parent", ref: `refs/pull/${ref.prId}/merge` };
  return { kind: "ref", ref: `refs/heads/${meta.headRef}` };
}

/**
 * Starts a clone or refresh of one PR in the background. Returns false when a
 * run for that PR is already in flight (the caller can follow it instead).
 */
function startSync(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  phase: SyncPhase,
  deps: ReviewDeps,
): boolean {
  return startRun(pr.id, (run) => syncPr(db, config, pr, phase, deps, run));
}

/**
 * Fetches the PR and makes it reviewable, then readies everything behind it.
 *
 * A failed clone leaves the row in `error`. A failed refresh leaves it `ready`
 * on the commits it already had, with the reason in `error`: the old checkout
 * is still a coherent thing to review.
 */
async function syncPr(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  phase: SyncPhase,
  deps: ReviewDeps,
  run: RunHandle,
): Promise<void> {
  const log = (text: string) => run.emit({ type: "log", text: `${text}\n` });
  run.emit({ type: "start", phase });
  if (phase === "clone") {
    await db
      .update(reviewWorkspacePrs)
      .set({ status: "cloning", error: null })
      .where(eq(reviewWorkspacePrs.id, pr.id));
  }

  let runners: ReviewGit;
  let clonePath: string;
  let shas: PrShas;
  try {
    assertWorktreeInWorkspace(config, pr);
    const meta = await deps.loadPr(pr.ref);
    for (const branch of [meta.baseRef, ...(meta.fromFork ? [] : [meta.headRef])]) {
      assertSafeBranchName(branch);
    }
    const remote = await deps.remoteFor(pr.ref);
    remotes.set(pr.id, remote);
    runners = deps.git(remote.env);
    clonePath = reviewClonePath(config, pr.ref);
    const cloneDir = clonePath;
    const gitRunner = runners.run;

    shas = await withCloneLock(cloneDir, async () => {
      log(existsSync(join(cloneDir, ".git")) ? "Using existing clone" : "Cloning (blobless)");
      await ensureReviewClone(gitRunner, remote.url, cloneDir);
      log(`Fetching ${meta.headRef} and ${meta.baseRef}`);
      return fetchPr(
        gitRunner,
        cloneDir,
        prNumber(pr.ref),
        headSourceFor(pr.ref, meta),
        meta.baseRef,
      );
    });

    await db
      .update(reviewWorkspacePrs)
      .set({
        status: "ready",
        error: null,
        title: meta.title,
        author: meta.author,
        headRef: meta.headRef,
        baseRef: meta.baseRef,
        worktreeStatus: "checking-out",
        ...shas,
      })
      .where(eq(reviewWorkspacePrs.id, pr.id));
    log(`Ready to review at ${shas.headSha.slice(0, 12)}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = phase === "refresh" ? "ready" : "error";
    // Emit before writing: a failing database is a likely way to get here, and
    // the event is what tells a watching view the run is over.
    run.emit({ type: "done", phase, status, error: message });
    await db
      .update(reviewWorkspacePrs)
      .set({ status, error: message })
      .where(eq(reviewWorkspacePrs.id, pr.id))
      .catch((err) => console.error("[review-workspaces] failed to record error:", err));
    return;
  }

  // Not needed for correctness — a read computes the same thing on demand — so
  // a failure here is only logged. Doing it now is what makes the first files
  // the reviewer opens instant instead of a fetch each.
  try {
    log("Downloading the changed files");
    await changedFiles(runners, clonePath, shas.mergeBaseSha, shas.headSha);
  } catch (e) {
    log(`Could not prefetch the changed files: ${e instanceof Error ? e.message : String(e)}`);
  }

  let checkoutError: string | null = null;
  try {
    const cloneDir = clonePath;
    await withCloneLock(cloneDir, () =>
      registerWorktree(runners.run, cloneDir, pr.worktreePath, shas.headSha),
    );
    log("Checking out the worktree");
    await checkoutWorktree(runners.run, pr.worktreePath, shas.headSha);
    await db
      .update(reviewWorkspacePrs)
      .set({ worktreeStatus: "ready" })
      .where(eq(reviewWorkspacePrs.id, pr.id));
  } catch (e) {
    checkoutError = `checkout failed: ${e instanceof Error ? e.message : String(e)}`;
    await db
      .update(reviewWorkspacePrs)
      .set({ worktreeStatus: "error", error: checkoutError })
      .where(eq(reviewWorkspacePrs.id, pr.id))
      .catch((err) => console.error("[review-workspaces] failed to record error:", err));
  }
  run.emit({ type: "done", phase, status: "ready", error: checkoutError });
}

/**
 * Restarts a clone that a sidecar restart interrupted. A row left `pending` or
 * `cloning` with no run in flight has nobody working on it; following its
 * progress is what notices.
 */
export function resumeIfStalled(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
): void {
  if ((pr.status === "pending" || pr.status === "cloning") && !isRunning(pr.id)) {
    startSync(db, config, pr, "clone", deps);
  }
}

/** Fetches the PR's current head and moves its worktree there. */
export async function refreshReviewPr(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReviewWorkspacePr> {
  await requireActiveWorkspace(db, workspaceId);
  const pr = await getReviewPr(db, workspaceId, prId);
  const phase = pr.status === "ready" ? "refresh" : "clone";
  if (!startSync(db, config, pr, phase, deps)) {
    throw new ReviewWorkspaceError("this pull request is already being updated", 409);
  }
  return pr;
}

/**
 * Removes a PR's worktree. Only ever deletes inside the review workspace's own
 * folder: the row's path is checked to be there, and `removeWorktree` refuses
 * to delete a leftover folder anywhere but directly under the root it is given.
 */
async function removePrWorktree(
  config: Config,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
): Promise<void> {
  assertWorktreeInWorkspace(config, pr);
  const clonePath = reviewClonePath(config, pr.ref);
  if (!existsSync(join(clonePath, ".git"))) {
    if (existsSync(pr.worktreePath)) {
      throw new Error(`${pr.worktreePath} has no clone to belong to; left in place`);
    }
    return;
  }
  await withCloneLock(clonePath, () =>
    removeWorktree(deps.git({}).run, clonePath, pr.worktreePath, {
      force: true,
      workspaceRoot: reviewWorkspaceDir(config, pr.workspaceId),
    }),
  );
}

export async function removeReviewPr(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<void> {
  const pr = await getReviewPr(db, workspaceId, prId);
  if (isRunning(pr.id)) {
    throw new ReviewWorkspaceError("this pull request is still being updated", 409);
  }
  await removePrWorktree(config, pr, deps);
  await db.delete(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, pr.id));
  forgetRuns(pr.id);
  remotes.delete(pr.id);
}

/**
 * Marks the workspace archiving and removes its worktrees in the background.
 * Clones stay for the next review of the same repo. Anything that couldn't be
 * removed is recorded in `error` and the workspace still ends `archived`.
 */
export async function archiveReviewWorkspace(
  db: Db,
  config: Config,
  id: string,
  deps: ReviewDeps,
): Promise<ReviewWorkspaceDetail> {
  // Conditional, so of two archives racing only one gets the row back and
  // goes on to remove anything.
  const [claimed] = await db
    .update(reviewWorkspaces)
    .set({ status: "archiving", updatedAt: new Date() })
    .where(and(eq(reviewWorkspaces.id, id), eq(reviewWorkspaces.status, "active")))
    .returning();
  if (!claimed) {
    const ws = await requireWorkspace(db, id);
    throw new ReviewWorkspaceError(`review workspace is already ${ws.status}`, 409);
  }
  const ws = await requireWorkspace(db, id);

  void (async () => {
    const failures: string[] = [];
    for (const pr of ws.prs) {
      try {
        await whenIdle(pr.id);
        forgetRuns(pr.id);
        remotes.delete(pr.id);
        await removePrWorktree(config, pr, deps);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    try {
      // Only removes an empty folder; anything left in it is what a failure
      // above kept, and is already reported.
      rmdirSync(reviewWorkspaceDir(config, id));
    } catch {}
    await db
      .update(reviewWorkspaces)
      .set({
        status: "archived",
        error: failures.length ? failures.join("; ") : null,
        updatedAt: new Date(),
      })
      .where(eq(reviewWorkspaces.id, id));
  })().catch((e) => console.error("[review-workspaces] archive failed:", e));

  return ws;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Review reads, keyed by sha. 64 MB holds the changed-file lists, trees and
 * open files of a good few large PRs; past that the least recently read go.
 */
const cache = new ShaCache(64 * 1024 * 1024);

function changedFiles(
  runners: ReviewGit,
  clonePath: string,
  mergeBaseSha: string,
  headSha: string,
): Promise<ChangedFileWithSizes[]> {
  return cache.get(
    `changed:${clonePath}:${mergeBaseSha}..${headSha}`,
    () => changedFilesBetween(runners.run, clonePath, mergeBaseSha, headSha),
    (files) => stringsSize(files.map((f) => f.path)) + files.length * 64,
  );
}

interface ReadyPr {
  pr: ReviewWorkspacePr;
  clonePath: string;
  runners: ReviewGit;
  headSha: string;
  mergeBaseSha: string;
}

async function requireReadyPr(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReadyPr> {
  const pr = await getReviewPr(db, workspaceId, prId);
  if (pr.status !== "ready" || !pr.headSha || !pr.mergeBaseSha) {
    throw new ReviewWorkspaceError(`pull request is ${pr.status}, not ready`, 409);
  }
  // Reads can fetch blobs a blobless clone doesn't have yet, so they carry the
  // remote's credentials like a fetch does.
  const remote = await remoteForPr(pr, deps);
  return {
    pr,
    clonePath: reviewClonePath(config, pr.ref),
    runners: deps.git(remote.env),
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
  };
}

/** The commits a read answered from, so the client can cache by them too. */
interface ReadShas {
  headSha: string;
  mergeBaseSha: string;
}

export async function reviewChangedFiles(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReadShas & { files: ReviewChangedFile[] }> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const files = await changedFiles(
    ready.runners,
    ready.clonePath,
    ready.mergeBaseSha,
    ready.headSha,
  );
  return {
    headSha: ready.headSha,
    mergeBaseSha: ready.mergeBaseSha,
    files: files.map(({ oldSize: _old, newSize: _new, ...file }) => file),
  };
}

export async function reviewTree(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<{ headSha: string; paths: string[] }> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const paths = await cache.get(
    `tree:${ready.clonePath}:${ready.headSha}`,
    () => treePaths(ready.runners.run, ready.clonePath, ready.headSha),
    stringsSize,
  );
  return { headSha: ready.headSha, paths };
}

/** A file at the PR's head or at the merge-base; 404 when that side has no such file. */
export async function reviewFile(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  path: string,
  side: "base" | "head",
  deps: ReviewDeps,
): Promise<FileAtSide & { sha: string }> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const sha = side === "head" ? ready.headSha : ready.mergeBaseSha;
  const file = await cache.get(
    `file:${ready.clonePath}:${sha}:${path}`,
    () => readFileAt(ready.runners, ready.clonePath, sha, path),
    (f) => (f?.content.length ?? 0) + 64,
  );
  if (!file) throw new ReviewWorkspaceError(`no file at ${path} on the ${side} side`, 404);
  return { ...file, sha };
}

interface ReviewFileDiff extends ReadShas {
  path: string;
  oldPath?: string;
  patch: string;
  /** Either side is over the size cap, so no patch was computed. */
  tooLarge: boolean;
}

/**
 * The patch for one changed file. The path has to be one the PR changes,
 * checked against the cached changed-file list, which also says where a
 * renamed file came from and whether either side is too big to diff.
 */
export async function reviewDiff(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  path: string,
  deps: ReviewDeps,
): Promise<ReviewFileDiff> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const files = await changedFiles(
    ready.runners,
    ready.clonePath,
    ready.mergeBaseSha,
    ready.headSha,
  );
  const file = files.find((f) => f.path === path);
  if (!file) throw new ReviewWorkspaceError(`${path} is not changed in this pull request`, 404);
  const base = {
    path,
    ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    headSha: ready.headSha,
    mergeBaseSha: ready.mergeBaseSha,
  };
  if (file.oldSize > MAX_FILE_BYTES || file.newSize > MAX_FILE_BYTES) {
    return { ...base, patch: "", tooLarge: true };
  }
  const patch = await cache.get(
    `diff:${ready.clonePath}:${ready.mergeBaseSha}..${ready.headSha}:${path}`,
    () =>
      fileDiffBetween(
        ready.runners.run,
        ready.clonePath,
        ready.mergeBaseSha,
        ready.headSha,
        path,
        file.oldPath,
      ),
    (p) => p.length + 64,
  );
  return { ...base, patch, tooLarge: false };
}

// ---------------------------------------------------------------------------
// Setup consent
// ---------------------------------------------------------------------------

interface SetupInfo {
  script: string | null;
  author: string | null;
  branch: string | null;
  consent: "granted" | "declined" | null;
  status: ReviewWorkspacePr["setupStatus"];
  log: string | null;
}

/** What the consent prompt shows: who wrote the PR, its branch, and the exact script. */
export async function reviewSetupInfo(
  db: Db,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<SetupInfo> {
  const pr = await getReviewPr(db, workspaceId, prId);
  return {
    script: await deps.setupScriptFor(pr.ref),
    author: pr.author,
    branch: pr.headRef,
    consent: pr.setupConsent,
    status: pr.setupStatus,
    log: pr.setupLog,
  };
}

async function updatePr(
  db: Db,
  id: string,
  values: Partial<ReviewWorkspacePr>,
): Promise<ReviewWorkspacePr> {
  const [row] = await db
    .update(reviewWorkspacePrs)
    .set(values)
    .where(eq(reviewWorkspacePrs.id, id))
    .returning();
  if (!row) throw new ReviewWorkspaceError("pull request not found", 404);
  return row;
}

/**
 * Records the user's answer and, on a yes, runs the setup script in the PR's
 * worktree in the background (output on the PR's progress stream).
 *
 * `script` is the script the user was shown. Running only when it still
 * matches is what makes the consent about *that* script: an edit to the
 * registered repo's setup between the prompt and the answer is refused rather
 * than run on the strength of a yes to something else.
 */
export async function answerReviewSetup(
  db: Db,
  workspaceId: string,
  prId: string,
  answer: { grant: boolean; script: string | null },
  deps: ReviewDeps,
): Promise<ReviewWorkspacePr> {
  await requireActiveWorkspace(db, workspaceId);
  const pr = await getReviewPr(db, workspaceId, prId);
  if (!answer.grant) return updatePr(db, pr.id, { setupConsent: "declined" });

  if (pr.worktreeStatus !== "ready") {
    throw new ReviewWorkspaceError(`the checkout is ${pr.worktreeStatus}, not ready`, 409);
  }
  const script = await deps.setupScriptFor(pr.ref);
  if (answer.script !== script) {
    throw new ReviewWorkspaceError(
      "the setup script changed since it was shown; review it again",
      409,
    );
  }
  if (!script) return updatePr(db, pr.id, { setupConsent: "granted", setupStatus: "skipped" });

  // Claimed before anything is written, so a request that loses the race to a
  // sync (or another yes) is refused without leaving `running` on the row.
  const run = claimRun(pr.id);
  if (!run) throw new ReviewWorkspaceError("this pull request is still being updated", 409);
  let row: ReviewWorkspacePr;
  try {
    row = await updatePr(db, pr.id, {
      setupConsent: "granted",
      setupStatus: "running",
      setupLog: null,
    });
  } catch (e) {
    run.finish();
    throw e;
  }
  void runSetup(db, pr, script, run);
  return row;
}

async function runSetup(
  db: Db,
  pr: ReviewWorkspacePr,
  script: string,
  run: RunHandle,
): Promise<void> {
  run.emit({ type: "start", phase: "setup" });
  let status: "succeeded" | "failed" = "failed";
  let error: string | null = null;
  // The row keeps the tail `runSetupScript` returns; the progress stream has
  // the whole output while the run is followable.
  let logTail = "";
  try {
    // The script's environment is the scrubbed one: no provider secrets, and
    // no git credentials — those are only ever handed to git.
    const result = await runSetupScript(pr.worktreePath, script, (text) => {
      run.emit({ type: "log", text });
    });
    logTail = result.logTail;
    status = result.exitCode === 0 ? "succeeded" : "failed";
    if (result.exitCode !== 0) error = `setup script exited ${result.exitCode}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  run.emit({ type: "done", phase: "setup", status, error });
  await db
    .update(reviewWorkspacePrs)
    .set({ setupStatus: status, setupLog: logTail })
    .where(eq(reviewWorkspacePrs.id, pr.id))
    .catch((err) => console.error("[review-workspaces] failed to record setup:", err))
    .finally(() => run.finish());
}
