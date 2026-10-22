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
 * Cloning and refreshing run in the background (see `progress.ts`); a PR row's
 * `status` says where that stands and its shas are what every read uses.
 */

import { randomUUID } from "node:crypto";
import { existsSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { isAllowedAzureOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type ReviewWorkspace,
  type ReviewWorkspacePr,
  reviewWorkspacePrs,
  reviewWorkspaces,
} from "../db/schema.ts";
import { prSourceFor } from "../pr/source.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { runStreaming } from "../workspaces/exec.ts";
import { removeWorktree } from "../workspaces/git.ts";
import {
  assertSafeBranchName,
  findRepoForPr,
  isSafePathSegment,
  isUniqueViolation,
  type PrLocator,
} from "../workspaces/service.ts";
import {
  changedFilesBetween,
  credentialEnv,
  ensureDetachedWorktree,
  ensureReviewClone,
  type FileAtSide,
  fetchPr,
  fileDiffBetween,
  type HeadSource,
  type ReviewChangedFile,
  type ReviewGit,
  readFileAt,
  reviewGit,
  treeEntry,
  treePaths,
} from "./git.ts";
import {
  forgetRuns,
  isRunning,
  type ReviewProgressEmit,
  type ReviewRunPhase,
  startRun,
  whenIdle,
} from "./progress.ts";

const SETUP_LOG_CAP = 16 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

/** A refusal with the HTTP status the route should answer with. */
export class ReviewWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

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
export interface PrRemote {
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
export function httpsRemoteFor(
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
  const enc = encodeURIComponent;
  return {
    url: `${base}/${enc(ref.project)}/_git/${enc(ref.repo)}`,
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

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Every review clone lives under here. */
export function reviewReposRoot(config: Pick<Config, "workspacesRoot">): string {
  return join(config.workspacesRoot, ".review-repos");
}

/** Every review worktree lives under here, one folder per review workspace. */
export function reviewWorktreesRoot(config: Pick<Config, "workspacesRoot">): string {
  return join(config.workspacesRoot, ".review");
}

/**
 * The clone for a PR's repo. One folder per identity segment rather than a
 * joined name, since `a-b/c` and `a/b-c` would otherwise share a folder.
 * Lower-cased because both providers treat these names case-insensitively.
 */
export function reviewClonePath(config: Pick<Config, "workspacesRoot">, ref: PrRef): string {
  const segments =
    ref.provider === "github"
      ? ["github", ref.owner, ref.repo]
      : ["azure", ref.org, ref.project, ref.repo];
  const lowered = segments.map((s) => s.toLowerCase());
  if (!lowered.every(isSafePathSegment)) {
    throw new ReviewWorkspaceError(`unsafe repository name in ${refKey(ref)}`, 400);
  }
  return join(reviewReposRoot(config), ...lowered);
}

/** The folder holding one review workspace's worktrees. */
export function reviewWorkspaceDir(config: Pick<Config, "workspacesRoot">, id: string): string {
  return join(reviewWorktreesRoot(config), id);
}

/** A DOM-id-safe variant of `refKey`, matching the frontend's `refDomKey`. */
export function refDomKey(ref: PrRef): string {
  return refKey(ref).replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Whether `path` is strictly inside `root`, after resolving `.` and `..`. */
function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface ReviewWorkspaceDetail extends ReviewWorkspace {
  prs: ReviewWorkspacePr[];
}

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
): Promise<ReviewWorkspaceDetail[]> {
  const rows = await db
    .select()
    .from(reviewWorkspaces)
    .where(includeArchived ? undefined : ne(reviewWorkspaces.status, "archived"))
    .orderBy(desc(reviewWorkspaces.lastOpenedAt), desc(reviewWorkspaces.createdAt));
  const prs = rows.length ? await db.select().from(reviewWorkspacePrs) : [];
  return rows.map((ws) => ({
    ...ws,
    prs: prs.filter((pr) => pr.workspaceId === ws.id).sort((a, b) => a.position - b.position),
  }));
}

export async function getReviewWorkspace(
  db: Db,
  id: string,
): Promise<ReviewWorkspaceDetail | null> {
  const [ws] = await db.select().from(reviewWorkspaces).where(eq(reviewWorkspaces.id, id));
  if (!ws) return null;
  return { ...ws, prs: await prsFor(db, id) };
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
  return (await getReviewWorkspace(db, ws.id)) as ReviewWorkspaceDetail;
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

async function activeWorkspace(db: Db, id: string): Promise<ReviewWorkspace> {
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
export function lowestUnused(taken: Iterable<number>): number {
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
  await activeWorkspace(db, workspaceId);
  reviewClonePath(config, ref);
  const existing = await prsFor(db, workspaceId);
  const key = refKey(ref);
  if (existing.some((pr) => pr.refKey === key)) {
    throw new ReviewWorkspaceError("this pull request is already in the workspace", 409);
  }

  const id = randomUUID();
  const dir = reviewWorkspaceDir(config, workspaceId);
  // Two refs can flatten to the same folder name (`a-b/c` and `a/b-c`); the
  // second one gets the row id on the end rather than sharing a checkout.
  let worktreePath = join(dir, refDomKey(ref));
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
        colorIndex: lowestUnused(existing.map((pr) => pr.colorIndex)),
        position: existing.reduce((max, pr) => Math.max(max, pr.position + 1), 0),
        worktreePath,
      })
      .returning();
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new ReviewWorkspaceError("this pull request is already in the workspace", 409);
    }
    throw e;
  }
  if (!row) throw new Error("failed to add pull request");
  startSync(db, config, row, "clone", deps);
  return row;
}

async function getPr(db: Db, workspaceId: string, prId: string): Promise<ReviewWorkspacePr> {
  const [row] = await db
    .select()
    .from(reviewWorkspacePrs)
    .where(and(eq(reviewWorkspacePrs.id, prId), eq(reviewWorkspacePrs.workspaceId, workspaceId)));
  if (!row) throw new ReviewWorkspaceError("pull request not found", 404);
  return row;
}

export { getPr as getReviewPr };

/** Serializes work on one review clone: fetches and worktree changes share its refs. */
const cloneLocks = new Map<string, Promise<unknown>>();

async function withCloneLock<T>(clonePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = cloneLocks.get(clonePath) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  cloneLocks.set(
    clonePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Where a PR's head commit is fetched from. */
export function headSourceFor(ref: PrRef, meta: Pick<PrMeta, "headRef" | "fromFork">): HeadSource {
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
 *
 * A failed clone leaves the row in `error`. A failed refresh leaves it `ready`
 * on the commits it already had, with the reason in `error`: the old checkout
 * is still a coherent thing to review.
 */
export function startSync(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  phase: Exclude<ReviewRunPhase, "setup">,
  deps: ReviewDeps,
): boolean {
  return startRun(pr.id, (emit) => syncPr(db, config, pr, phase, deps, emit));
}

async function syncPr(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  phase: Exclude<ReviewRunPhase, "setup">,
  deps: ReviewDeps,
  emit: ReviewProgressEmit,
): Promise<void> {
  const log = (text: string) => emit({ type: "log", text: `${text}\n` });
  await emit({ type: "start", phase });
  if (phase === "clone") {
    await db
      .update(reviewWorkspacePrs)
      .set({ status: "cloning", error: null })
      .where(eq(reviewWorkspacePrs.id, pr.id));
  }
  try {
    const meta = await deps.loadPr(pr.ref);
    for (const branch of [meta.baseRef, ...(meta.fromFork ? [] : [meta.headRef])]) {
      assertSafeBranchName(branch);
    }
    const remote = await deps.remoteFor(pr.ref);
    const git = deps.git(remote.env);
    const clonePath = reviewClonePath(config, pr.ref);
    if (!isInside(reviewWorktreesRoot(config), pr.worktreePath)) {
      throw new Error("worktree path is outside the review folder");
    }

    const shas = await withCloneLock(clonePath, async () => {
      await log(
        existsSync(join(clonePath, ".git")) ? "Using existing clone" : "Cloning (blobless)",
      );
      await ensureReviewClone(git.run, remote.url, clonePath);
      await log(`Fetching ${meta.headRef} and ${meta.baseRef}`);
      const fetched = await fetchPr(
        git.run,
        clonePath,
        prNumber(pr.ref),
        headSourceFor(pr.ref, meta),
        meta.baseRef,
      );
      await log(`Checking out ${fetched.headSha.slice(0, 12)}`);
      await ensureDetachedWorktree(git.run, clonePath, pr.worktreePath, fetched.headSha);
      return fetched;
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
        ...shas,
      })
      .where(eq(reviewWorkspacePrs.id, pr.id));
    await emit({ type: "done", phase, status: "ready", error: null });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = phase === "refresh" && pr.status === "ready" ? "ready" : "error";
    // Emit before writing: a failing database is a likely way to get here, and
    // the event is what tells a watching view the run is over.
    await emit({ type: "done", phase, status, error: message });
    await db
      .update(reviewWorkspacePrs)
      .set({ status, error: message })
      .where(eq(reviewWorkspacePrs.id, pr.id))
      .catch((err) => console.error("[review-workspaces] failed to record error:", err));
  }
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
  await activeWorkspace(db, workspaceId);
  const pr = await getPr(db, workspaceId, prId);
  const phase = pr.status === "ready" ? "refresh" : "clone";
  if (!startSync(db, config, pr, phase, deps)) {
    throw new ReviewWorkspaceError("this pull request is already being updated", 409);
  }
  return pr;
}

/**
 * Removes the worktree at `worktreePath`. Only ever deletes inside the review
 * workspace's own folder: `removeWorktree` refuses to delete a leftover folder
 * anywhere but directly under the root it is given, and the row's path is
 * checked to be there first.
 */
async function removePrWorktree(
  config: Config,
  workspaceId: string,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
): Promise<void> {
  const dir = reviewWorkspaceDir(config, workspaceId);
  if (dirname(resolve(pr.worktreePath)) !== resolve(dir)) {
    throw new Error(`${pr.worktreePath} is not in this review workspace's folder; left in place`);
  }
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
      workspaceRoot: dir,
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
  const pr = await getPr(db, workspaceId, prId);
  if (isRunning(pr.id)) {
    throw new ReviewWorkspaceError("this pull request is still being updated", 409);
  }
  await removePrWorktree(config, workspaceId, pr, deps);
  await db.delete(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, pr.id));
  forgetRuns(pr.id);
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
): Promise<{ workspace: ReviewWorkspaceDetail; done: Promise<void> }> {
  const ws = await getReviewWorkspace(db, id);
  if (!ws) throw new ReviewWorkspaceError("review workspace not found", 404);
  if (ws.status !== "active") {
    throw new ReviewWorkspaceError(`review workspace is already ${ws.status}`, 409);
  }
  await db
    .update(reviewWorkspaces)
    .set({ status: "archiving", updatedAt: new Date() })
    .where(eq(reviewWorkspaces.id, id));

  const done = (async () => {
    const failures: string[] = [];
    for (const pr of ws.prs) {
      try {
        await whenIdle(pr.id);
        await removePrWorktree(config, id, pr, deps);
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    const dir = reviewWorkspaceDir(config, id);
    if (isInside(reviewWorktreesRoot(config), dir) && existsSync(dir)) {
      try {
        // Only an empty folder: anything left is what a failure above kept.
        rmdirSync(dir);
      } catch {}
    }
    await db
      .update(reviewWorkspaces)
      .set({
        status: "archived",
        error: failures.length ? failures.join("; ") : null,
        updatedAt: new Date(),
      })
      .where(eq(reviewWorkspaces.id, id));
  })().catch((e) => console.error("[review-workspaces] archive failed:", e));

  return { workspace: (await getReviewWorkspace(db, id)) as ReviewWorkspaceDetail, done };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface ReadyPr {
  pr: ReviewWorkspacePr;
  clonePath: string;
  git: ReviewGit;
  headSha: string;
  mergeBaseSha: string;
}

async function readyPr(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReadyPr> {
  const pr = await getPr(db, workspaceId, prId);
  if (pr.status !== "ready" || !pr.headSha || !pr.mergeBaseSha) {
    throw new ReviewWorkspaceError(`pull request is ${pr.status}, not ready`, 409);
  }
  // Reads can fetch blobs a blobless clone doesn't have yet, so they carry the
  // remote's credentials like a fetch does.
  const remote = await deps.remoteFor(pr.ref);
  return {
    pr,
    clonePath: reviewClonePath(config, pr.ref),
    git: deps.git(remote.env),
    headSha: pr.headSha,
    mergeBaseSha: pr.mergeBaseSha,
  };
}

export async function reviewChangedFiles(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReviewChangedFile[]> {
  const ready = await readyPr(db, config, workspaceId, prId, deps);
  return changedFilesBetween(ready.git.run, ready.clonePath, ready.mergeBaseSha, ready.headSha);
}

export async function reviewTree(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<string[]> {
  const ready = await readyPr(db, config, workspaceId, prId, deps);
  return treePaths(ready.git.run, ready.clonePath, ready.headSha);
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
): Promise<FileAtSide> {
  const ready = await readyPr(db, config, workspaceId, prId, deps);
  const sha = side === "head" ? ready.headSha : ready.mergeBaseSha;
  const file = await readFileAt(ready.git, ready.clonePath, sha, path);
  if (!file) throw new ReviewWorkspaceError(`no file at ${path} on the ${side} side`, 404);
  return file;
}

/**
 * The patch for one file. The path has to exist on one side or the other, so
 * a request can't use this to diff arbitrary pathspecs.
 */
export async function reviewDiff(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  path: string,
  oldPath: string | undefined,
  deps: ReviewDeps,
): Promise<string> {
  const ready = await readyPr(db, config, workspaceId, prId, deps);
  const { run } = ready.git;
  const [atHead, atBase] = await Promise.all([
    treeEntry(run, ready.clonePath, ready.headSha, path),
    treeEntry(run, ready.clonePath, ready.mergeBaseSha, path),
  ]);
  if (!atHead && !atBase) throw new ReviewWorkspaceError(`no file at ${path}`, 404);
  if (oldPath && !(await treeEntry(run, ready.clonePath, ready.mergeBaseSha, oldPath))) {
    throw new ReviewWorkspaceError(`no file at ${oldPath} on the base side`, 404);
  }
  return fileDiffBetween(run, ready.clonePath, ready.mergeBaseSha, ready.headSha, path, oldPath);
}

// ---------------------------------------------------------------------------
// Setup consent
// ---------------------------------------------------------------------------

export interface SetupInfo {
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
  const pr = await getPr(db, workspaceId, prId);
  return {
    script: await deps.setupScriptFor(pr.ref),
    author: pr.author,
    branch: pr.headRef,
    consent: pr.setupConsent,
    status: pr.setupStatus,
    log: pr.setupLog,
  };
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
  await activeWorkspace(db, workspaceId);
  const pr = await getPr(db, workspaceId, prId);
  if (!answer.grant) {
    const [row] = await db
      .update(reviewWorkspacePrs)
      .set({ setupConsent: "declined" })
      .where(eq(reviewWorkspacePrs.id, pr.id))
      .returning();
    return row as ReviewWorkspacePr;
  }

  if (pr.status !== "ready") {
    throw new ReviewWorkspaceError(`pull request is ${pr.status}, not ready`, 409);
  }
  const script = await deps.setupScriptFor(pr.ref);
  if ((answer.script ?? null) !== script) {
    throw new ReviewWorkspaceError(
      "the setup script changed since it was shown; review it again",
      409,
    );
  }
  if (isRunning(pr.id)) {
    throw new ReviewWorkspaceError("this pull request is still being updated", 409);
  }

  const [row] = await db
    .update(reviewWorkspacePrs)
    .set({ setupConsent: "granted", setupStatus: script ? "running" : "skipped", setupLog: null })
    .where(eq(reviewWorkspacePrs.id, pr.id))
    .returning();
  if (script) {
    startRun(pr.id, (emit) => runSetup(db, pr, script, emit));
  }
  return row as ReviewWorkspacePr;
}

async function runSetup(
  db: Db,
  pr: ReviewWorkspacePr,
  script: string,
  emit: ReviewProgressEmit,
): Promise<void> {
  await emit({ type: "start", phase: "setup" });
  let tail = "";
  let status: "succeeded" | "failed" = "failed";
  let error: string | null = null;
  try {
    // `bash -c`, not `-lc`: a login shell would source the user's profile and
    // re-import the secrets `exec.ts` strips. The environment carries no git
    // credentials either — those are only ever handed to git.
    const exitCode = await runStreaming(["bash", "-c", script], {
      cwd: pr.worktreePath,
      timeoutMs: SETUP_TIMEOUT_MS,
      onChunk: async (text) => {
        tail = (tail + text).slice(-SETUP_LOG_CAP);
        await emit({ type: "log", text });
      },
    });
    status = exitCode === 0 ? "succeeded" : "failed";
    if (exitCode !== 0) error = `setup script exited ${exitCode}`;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  await emit({ type: "done", phase: "setup", status, error });
  await db
    .update(reviewWorkspacePrs)
    .set({ setupStatus: status, setupLog: tail })
    .where(eq(reviewWorkspacePrs.id, pr.id))
    .catch((err) => console.error("[review-workspaces] failed to record setup:", err));
}
