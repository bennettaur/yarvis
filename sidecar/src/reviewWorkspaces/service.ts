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
import { createGitHubClient } from "../github/client.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError, redactSecrets } from "../llm/errors.ts";
import { type ReviewMarkProvider, recentMarkShas, reviewMarkProvider } from "../pr/reviewMarks.ts";
import { prSourceFor } from "../pr/source.ts";
import { NO_PULL_REQUEST, type PrRef, type PrStack, refKey } from "../pr/types.ts";
import { runSetupScript } from "../workspaces/exec.ts";
import { MAX_FILE_BYTES } from "../workspaces/files.ts";
import { git, removeWorktree, splitNulFields } from "../workspaces/git.ts";
import {
  assertSafeBranchName,
  findRepoForPr,
  isSafePathSegment,
  isUniqueViolation,
  type PrLocator,
} from "../workspaces/service.ts";
import { ShaCache, stringsSize } from "./cache.ts";
import {
  type GrepResult,
  grepSymbol,
  languageFamilyForPath,
  pickDefinitions,
  pickReferences,
  type SymbolQuery,
  type SymbolSearchResult,
} from "./definitions.ts";
import {
  assertSafeRepoPath,
  type ChangedFileWithSizes,
  changedFilesBetween,
  checkoutWorktree,
  ensureReviewClone,
  type FileAtSide,
  fetchPr,
  fileDiffBetween,
  fileDiffCapped,
  type GitCredentials,
  generatedByAttributes,
  type HeadSource,
  type PrShas,
  prefetchTree,
  type ReviewChangedFile,
  type ReviewGit,
  type ReviewGitOptions,
  readFileAt,
  registerWorktree,
  reviewGit,
  treePaths,
} from "./git.ts";
import { bulkKind, type PatchSource } from "./patchFiles.ts";
import {
  claimRun,
  forgetRuns,
  isRunning,
  type ReviewRunPhase,
  type RunHandle,
  startRun,
  whenIdle,
} from "./progress.ts";
import { restoreGitState, snapshotGitState } from "./setupGuard.ts";
import { ensureCommit, pinReviewedCommit, unpinReviewedCommits } from "./sinceReview.ts";

/** A refusal with the HTTP status the route should answer with. */
export class ReviewWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
    this.name = "ReviewWorkspaceError";
  }
}

type SyncPhase = Exclude<ReviewRunPhase, "setup">;

/** A failure's message, with anything shaped like a credential taken out. */
function safeMessage(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e));
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

export interface ReviewDeps {
  loadPr(ref: PrRef): Promise<PrMeta>;
  /** The registered repo's clone URL, or the provider's https URL. */
  remoteUrlFor(ref: PrRef): Promise<string>;
  /**
   * The provider token for git, built from configuration on every call so a
   * rotated or removed token takes effect at once and no copy is kept around.
   */
  credentialsFor(ref: PrRef): GitCredentials | undefined;
  /** The registered repo's setup script for this PR's repo, if there is one. */
  setupScriptFor(ref: PrRef): Promise<string | null>;
  git(options: ReviewGitOptions): ReviewGit;
  /**
   * Where the viewer's own provider-side reviews are read from, for the
   * last-review mark; null (or absent) when the provider isn't configured.
   */
  markProvider?(ref: PrRef): ReviewMarkProvider | null;
  /**
   * The other open pull requests in `ref`'s stack, bottom first; empty when it
   * isn't stacked or the provider has no stacks. Absent means the same.
   */
  stackOf?(ref: PrRef): Promise<PrRef[]>;
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
 * The https remote for a PR's repo and the credentials for it. GitHub's host is
 * fixed; Azure's comes from the configured organization URL, which is checked
 * to be an Azure DevOps host before a token is sent to it.
 */
export function httpsRemoteFor(
  config: Pick<Config, "secrets">,
  ref: PrRef,
): { url: string; credentials?: GitCredentials } {
  if (ref.provider === "github") {
    const token = config.secrets.githubToken;
    return {
      url: `https://github.com/${ref.owner}/${ref.repo}.git`,
      ...(token ? { credentials: { host: "github.com", username: "x-access-token", token } } : {}),
    };
  }
  const orgUrl = config.secrets.azureDevopsOrgUrl;
  if (!orgUrl || !isAllowedAzureOrgUrl(orgUrl)) {
    throw new ReviewWorkspaceError("azure devops is not configured", 400);
  }
  const base = orgUrl.replace(/\/+$/, "");
  const token = config.secrets.azureDevopsToken;
  return {
    url: `${base}/${encodeURIComponent(ref.project)}/_git/${encodeURIComponent(ref.repo)}`,
    ...(token ? { credentials: { host: new URL(base).hostname, username: "yarvis", token } } : {}),
  };
}

/**
 * The real dependencies. A registered repo's clone URL wins — usually ssh,
 * authenticated by the user's agent the way coding workspaces are — and an
 * unregistered one is fetched over https. Either way the provider token rides
 * along on network commands, through a credential helper that only answers an
 * https request to the provider's own host, so it is unused on an ssh remote.
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
    async remoteUrlFor(ref) {
      const registered = await findRepoForPr(db, locatorFor(ref));
      return registered?.cloneUrl ?? httpsRemoteFor(config, ref).url;
    },
    credentialsFor(ref) {
      try {
        return httpsRemoteFor(config, ref).credentials;
      } catch {
        // No usable Azure org URL: nothing to authenticate to over https, and a
        // registered ssh remote needs no token.
        return undefined;
      }
    },
    async setupScriptFor(ref) {
      const registered = await findRepoForPr(db, locatorFor(ref));
      return registered?.setupScript?.trim() ? registered.setupScript : null;
    },
    git: reviewGit,
    markProvider: (ref) => reviewMarkProvider(config, ref),
    async stackOf(ref) {
      if (ref.provider !== "github") return [];
      const token = config.secrets.githubToken;
      if (!token) return [];
      const stack = await createGitHubClient(config, token).prStack(
        ref.owner,
        ref.repo,
        ref.number,
      );
      return otherOpenLayers(stack);
    },
  };
}

/**
 * The runners for a PR's clone, with the provider credentials as they are now.
 * Reads never need the remote URL — a blob fetch goes to the clone's `origin`
 * — so only a sync resolves it, and only credentials are rebuilt per call.
 */
function runnersFor(pr: ReviewWorkspacePr, deps: ReviewDeps): ReviewGit {
  return deps.git({ credentials: deps.credentialsFor(pr.ref) });
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

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
  return join(config.workspacesRoot, ".review-repos", ...lowered);
}

/** The folder holding one review workspace's worktrees. */
/** The folder holding every review workspace's folder. */
export function reviewWorkspacesRoot(config: Pick<Config, "workspacesRoot">): string {
  return join(config.workspacesRoot, ".review");
}

export function reviewWorkspaceDir(config: Pick<Config, "workspacesRoot">, id: string): string {
  return join(reviewWorkspacesRoot(config), id);
}

/** A DOM-id-safe variant of `refKey`, matching the frontend's `refDomKey`. */
export function refDomKey(ref: PrRef): string {
  return refKey(ref).replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Throws unless the PR's worktree path sits directly in its workspace's folder.
 * Checked before anything is checked out, run or deleted there, so a row that
 * somehow named another path can't point any of those at the rest of the disk.
 */
export function assertWorktreeInWorkspace(
  config: Pick<Config, "workspacesRoot">,
  pr: Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">,
): void {
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
  void startStackLayers(db, config, ws.id, input.refs ?? [], deps);
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

export async function requireActiveWorkspace(db: Db, id: string): Promise<ReviewWorkspace> {
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

/**
 * The layers of a stack worth reviewing beside the one it was looked up from:
 * open pull requests only, bottom first. A merged layer's change is already in
 * the trunk, and a branch with no PR has nothing to check out.
 */
export function otherOpenLayers(stack: PrStack): PrRef[] {
  return stack.entries
    .filter((e) => !e.isCurrent && e.number !== NO_PULL_REQUEST && e.state === "open")
    .map((e) => e.ref);
}

/**
 * Adds the other open layers of each ref's stack that the workspace doesn't
 * hold yet, in the background: the lookup is a GitHub round trip per layer, and
 * the workspace view already polls while the PR it asked for clones. A layer's
 * diff is only its own change, so it reads properly only beside the layers
 * around it. The PRs asked for are reviewable without them, so a failed lookup
 * or add is logged, not thrown. Answers with the background work, for tests.
 */
export function startStackLayers(
  db: Db,
  config: Config,
  workspaceId: string,
  refs: PrRef[],
  deps: ReviewDeps,
): Promise<void> {
  return (async () => {
    // A ref an earlier lookup already reached is in the same stack.
    const reached = new Set<string>();
    for (const ref of refs) {
      if (reached.has(refKey(ref))) continue;
      let layers: PrRef[];
      try {
        layers = (await deps.stackOf?.(ref)) ?? [];
      } catch (e) {
        console.error("[review-workspaces] could not read the stack:", describeError(e));
        continue;
      }
      const held = new Set((await prsFor(db, workspaceId)).map((pr) => pr.refKey));
      for (const layer of layers) {
        const key = refKey(layer);
        reached.add(key);
        if (held.has(key)) continue;
        try {
          await addReviewPr(db, config, workspaceId, layer, deps);
        } catch (e) {
          console.error("[review-workspaces] could not add a stack layer:", describeError(e));
        }
      }
    }
  })().catch((e) => console.error("[review-workspaces] stack layers:", describeError(e)));
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
 * Serializes what changes a review clone's refs, config or worktree list:
 * clone, fetch, registering a worktree, and restoring the config after setup.
 * Checkouts and reads don't hold it, so one PR's slow checkout never queues
 * another PR's fetch behind it.
 */
export const withCloneLock = createKeyedLock();

/** How many of a PR's latest reviewed commits a sync keeps pinned. */
const PINNED_REVIEWS = 20;

/**
 * Makes sure a reviewed commit is in the clone (fetching it outside the lock,
 * since that is a network call) and pins it under the lock. False when the
 * remote doesn't have it either.
 */
export async function keepReviewedCommit(
  runners: ReviewGit,
  clonePath: string,
  ref: PrRef,
  sha: string,
): Promise<boolean> {
  if (!(await ensureCommit(runners, clonePath, sha))) return false;
  return withCloneLock(clonePath, () => pinReviewedCommit(runners, clonePath, refDomKey(ref), sha));
}

async function keepReviewedCommits(
  db: Db,
  runners: ReviewGit,
  clonePath: string,
  ref: PrRef,
): Promise<void> {
  for (const sha of await recentMarkShas(db, ref, PINNED_REVIEWS)) {
    await keepReviewedCommit(runners, clonePath, ref, sha);
  }
}

/**
 * Drops the reviewed-commit refs of a PR leaving review, unless another active
 * workspace still has it. Never fails the removal: refs left behind cost a
 * little disk, nothing else.
 */
async function releaseReviewedCommits(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
): Promise<void> {
  try {
    const clonePath = reviewClonePath(config, pr.ref);
    if (!existsSync(join(clonePath, ".git"))) return;
    const [stillReviewed] = await db
      .select({ id: reviewWorkspacePrs.id })
      .from(reviewWorkspacePrs)
      .innerJoin(reviewWorkspaces, eq(reviewWorkspaces.id, reviewWorkspacePrs.workspaceId))
      .where(
        and(
          eq(reviewWorkspacePrs.refKey, pr.refKey),
          ne(reviewWorkspacePrs.id, pr.id),
          eq(reviewWorkspaces.status, "active"),
        ),
      )
      .limit(1);
    if (stillReviewed) return;
    await withCloneLock(clonePath, () =>
      unpinReviewedCommits(deps.git({}), clonePath, refDomKey(pr.ref)),
    );
  } catch (e) {
    console.warn("[review-workspaces] could not release the reviewed commits:", describeError(e));
  }
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

  const runners = runnersFor(pr, deps);
  let clonePath: string;
  let shas: PrShas;
  try {
    assertWorktreeInWorkspace(config, pr);
    const meta = await deps.loadPr(pr.ref);
    // The head branch is checked even for a fork, where it isn't fetched: it is
    // still shown, logged and stored.
    assertSafeBranchName(meta.baseRef);
    assertSafeBranchName(meta.headRef);
    const url = await deps.remoteUrlFor(pr.ref);
    const cloneDir = reviewClonePath(config, pr.ref);
    clonePath = cloneDir;

    shas = await withCloneLock(cloneDir, async () => {
      log(existsSync(join(cloneDir, ".git")) ? "Using existing clone" : "Cloning (blobless)");
      await ensureReviewClone(runners, url, cloneDir);
      log(`Fetching ${meta.headRef} and ${meta.baseRef}`);
      return fetchPr(
        runners,
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
    const message = safeMessage(e);
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
    log(`Could not prefetch the changed files: ${safeMessage(e)}`);
  }

  // Where the reviews were is kept now rather than when "since last review" is
  // read, so that read neither fetches nor writes a ref.
  try {
    await keepReviewedCommits(db, runners, clonePath, pr.ref);
  } catch (e) {
    log(`Could not keep the reviewed commits: ${safeMessage(e)}`);
  }

  let checkoutError: string | null = null;
  try {
    await withCloneLock(clonePath, () =>
      registerWorktree(runners.local, clonePath, pr.worktreePath, shas.headSha),
    );
    log("Checking out the worktree");
    // The checkout itself runs without credentials, so whatever the tree
    // needs is downloaded first, in one batch.
    await prefetchTree(runners, clonePath, shas.headSha);
    await checkoutWorktree(runners.local, pr.worktreePath, shas.headSha);
    await db
      .update(reviewWorkspacePrs)
      .set({ worktreeStatus: "ready" })
      .where(eq(reviewWorkspacePrs.id, pr.id));
  } catch (e) {
    checkoutError = `checkout failed: ${safeMessage(e)}`;
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
 * progress is what notices. Never for a workspace being archived or archived:
 * that would recreate the worktree the archive is removing.
 */
export async function resumeIfStalled(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
): Promise<void> {
  if (pr.status !== "pending" && pr.status !== "cloning") return;
  if (isRunning(pr.id)) return;
  const [ws] = await db
    .select({ status: reviewWorkspaces.status })
    .from(reviewWorkspaces)
    .where(eq(reviewWorkspaces.id, pr.workspaceId));
  if (ws?.status !== "active") return;
  startSync(db, config, pr, "clone", deps);
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
    removeWorktree(deps.git({}).local, clonePath, pr.worktreePath, {
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
  await releaseReviewedCommits(db, config, pr, deps);
  await db.delete(reviewWorkspacePrs).where(eq(reviewWorkspacePrs.id, pr.id));
  forgetRuns(pr.id);
}

/**
 * Marks the workspace archiving and removes its worktrees in the background,
 * after any run in flight for each PR has finished. Clones stay for the next
 * review of the same repo. Anything that couldn't be removed is recorded in
 * `error` and the workspace still ends `archived`.
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
        await removePrWorktree(config, pr, deps);
        await releaseReviewedCommits(db, config, pr, deps);
      } catch (e) {
        failures.push(safeMessage(e));
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
export const cache = new ShaCache(64 * 1024 * 1024);

export function changedFiles(
  runners: ReviewGit,
  clonePath: string,
  mergeBaseSha: string,
  headSha: string,
): Promise<ChangedFileWithSizes[]> {
  return cache.get(
    `changed:${clonePath}:${mergeBaseSha}..${headSha}`,
    () => changedFilesBetween(runners, clonePath, mergeBaseSha, headSha),
    (files) => stringsSize(files.map((f) => f.path)) + files.length * 64,
  );
}

export interface ReadyPr {
  pr: ReviewWorkspacePr;
  clonePath: string;
  runners: ReviewGit;
  headSha: string;
  mergeBaseSha: string;
}

export async function requireReadyPr(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
): Promise<ReadyPr> {
  return readyFrom(config, await getReviewPr(db, workspaceId, prId), deps);
}

function readyFrom(config: Config, pr: ReviewWorkspacePr, deps: ReviewDeps): ReadyPr {
  if (pr.status !== "ready" || !pr.headSha || !pr.mergeBaseSha) {
    throw new ReviewWorkspaceError(`pull request is ${pr.status}, not ready`, 409);
  }
  return {
    pr,
    clonePath: reviewClonePath(config, pr.ref),
    runners: runnersFor(pr, deps),
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
    () => treePaths(ready.runners.local, ready.clonePath, ready.headSha),
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
  const file = await cachedFileAt(ready, sha, path);
  if (!file) throw new ReviewWorkspaceError(`no file at ${path} on the ${side} side`, 404);
  return { ...file, sha };
}

/**
 * A file at `sha`, cached under one key for every reader. `fetchMissing:
 * false` reads only what the clone already has: a blob it lacks reads as no
 * file, and that answer isn't cached, since a fetching read could still find it.
 */
export function cachedFileAt(
  ready: ReadyPr,
  sha: string,
  path: string,
  { fetchMissing = true }: { fetchMissing?: boolean } = {},
): Promise<FileAtSide | null> {
  const key = `file:${ready.clonePath}:${sha}:${path}`;
  const read = () =>
    readFileAt(ready.runners, ready.clonePath, sha, path, MAX_FILE_BYTES, { fetchMissing });
  if (!fetchMissing && !cache.has(key)) return read();
  return cache.get(key, read, (f) => (f?.content.length ?? 0) + 64);
}

export type SymbolSearchKind = "definitions" | "references";

/** A search that ran out of time, kept out of the cache so the next try runs it again. */
class SearchTimedOut extends Error {
  constructor(readonly result: GrepResult) {
    super("search timed out");
  }
}

/**
 * Where a symbol is declared, or used, at the PR's head, found by `git grep`
 * over the commit (`definitions.ts`). Waits for the checkout, not for its
 * files but for what it guarantees: every blob of the head tree is local by
 * then, so the search, and the read of the asking file for the imports that
 * rank the answers, use only the local runner and never fetch. Definitions
 * and references share one cached search per symbol and language.
 */
export async function reviewSymbolSearch(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  kind: SymbolSearchKind,
  query: Omit<SymbolQuery, "content">,
  deps: ReviewDeps,
): Promise<SymbolSearchResult & { headSha: string }> {
  assertSafeRepoPath(query.path);
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  if (ready.pr.worktreeStatus !== "ready") {
    throw new ReviewWorkspaceError(`the checkout is ${ready.pr.worktreeStatus}, not ready`, 409);
  }
  const asking = await cachedFileAt(ready, ready.headSha, query.path, { fetchMissing: false });
  const family = languageFamilyForPath(query.path);
  let found: GrepResult;
  try {
    found = await cache.get(
      `grep:${ready.clonePath}:${ready.headSha}:${family ?? "*"}:${query.symbol}`,
      async () => {
        const result = await grepSymbol(
          ready.runners.search,
          ready.clonePath,
          ready.headSha,
          query.symbol,
          family,
        );
        if (result.timedOut) throw new SearchTimedOut(result);
        return result;
      },
      (result) => stringsSize(result.lines.map((line) => line.text + line.path)),
    );
  } catch (e) {
    if (e instanceof SearchTimedOut) found = e.result;
    else throw e;
  }
  const withContent = { ...query, content: asking?.content };
  const result =
    kind === "definitions"
      ? pickDefinitions(found, withContent)
      : pickReferences(found, withContent);
  return { ...result, headSha: ready.headSha };
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
        ready.runners.local,
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

/** How a changed file reads for an agent: bulk to skim, and whether the PR marked it generated. */
export interface BulkClass {
  skim: string | null;
  markedByPr: boolean;
}

/**
 * {@link bulkKind} for each of `paths`, with `.gitattributes` read at
 * `baseSha` (whose word counts) and `headSha` (to say when the PR added a
 * mark). Cached by commit. When the attributes can't be read the paths alone
 * decide, which only ever makes fewer files bulk.
 */
export async function classifyBulk(
  ready: Pick<ReadyPr, "runners" | "clonePath">,
  baseSha: string,
  headSha: string,
  paths: string[],
): Promise<Map<string, BulkClass>> {
  const marked = (sha: string) =>
    cache
      .get(
        `attrs:${ready.clonePath}:${sha}:${Bun.hash(paths.join("\0"))}`,
        () => generatedByAttributes(ready.runners.network, ready.clonePath, sha, paths),
        (s) => stringsSize([...s]) + 64,
      )
      .catch((e) => {
        console.error("[review-workspaces] could not read .gitattributes:", describeError(e));
        return new Set<string>();
      });
  // Which paths the merge-base already had; trees are local. When this can't
  // be read, none count as existing, so path-only bulk is read in full.
  const existing = cache
    .get(
      `base-paths:${ready.clonePath}:${baseSha}:${Bun.hash(paths.join("\0"))}`,
      async () =>
        new Set(
          paths.length === 0
            ? []
            : splitNulFields(
                await git(
                  ready.runners.local,
                  ["--literal-pathspecs", "ls-tree", "-z", "--name-only", baseSha, "--", ...paths],
                  ready.clonePath,
                ),
              ),
        ),
      (s) => stringsSize([...s]) + 64,
    )
    .catch((e) => {
      console.error("[review-workspaces] could not list the merge-base's files:", describeError(e));
      return new Set<string>();
    });
  const [atBase, atHead, existed] = await Promise.all([marked(baseSha), marked(headSha), existing]);
  return new Map(
    paths.map((path) => {
      const skim = bulkKind(path, atBase, existed.has(path));
      return [path, { skim, markedByPr: !skim && atHead.has(path) }];
    }),
  );
}

/**
 * A diff can't be much bigger than both sides together, so only a file this
 * close to the cap has its diff read to see whether it goes over.
 */
const mayOverflow = (f: ChangedFileWithSizes, maxPatchBytes: number) =>
  !f.binary && 2 * (f.oldSize + f.newSize) + 64 * 1024 > maxPatchBytes;

/**
 * The PR's changed files with their sizes, and which of them have a diff over
 * `maxPatchBytes`, which an agent run is given only the start of. Found
 * without diffing every file: only one big enough to get there is read, up to
 * the cap, and the answer is cached by commit.
 */
export async function reviewDiffFacts(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  deps: ReviewDeps,
  maxPatchBytes: number,
): Promise<{
  files: ChangedFileWithSizes[];
  truncated: string[];
  bulk: Map<string, BulkClass>;
}> {
  const ready = await requireReadyPr(db, config, workspaceId, prId, deps);
  const files = await changedFiles(
    ready.runners,
    ready.clonePath,
    ready.mergeBaseSha,
    ready.headSha,
  );
  const truncated: string[] = [];
  for (const file of files.filter((f) => mayOverflow(f, maxPatchBytes))) {
    const complete = await cache.get(
      `diff-complete:${ready.clonePath}:${ready.mergeBaseSha}..${ready.headSha}:${maxPatchBytes}:${file.path}`,
      async () =>
        (
          await fileDiffCapped(
            ready.runners.search,
            ready.clonePath,
            ready.mergeBaseSha,
            ready.headSha,
            file.path,
            file.oldPath,
            maxPatchBytes + 1,
          )
        ).complete,
      () => 64,
    );
    if (!complete) truncated.push(file.path);
  }
  const bulk = await classifyBulk(
    ready,
    ready.mergeBaseSha,
    ready.headSha,
    files.map((f) => f.path),
  );
  return { files, truncated, bulk };
}

/**
 * Every changed file, in path order, for a reader that wants the whole PR at
 * once (an agent run), each with its patch read only when it is written out.
 * Nothing is left out: a binary file has no patch, and any other file's patch
 * is read up to `maxPatchBytes` (plus one byte, so a patch past it reads as
 * incomplete).
 *
 * Takes the PR row rather than reading it, so a caller that also uses the
 * row's head and worktree gets patches from that same head.
 */
export async function reviewPatchSources(
  config: Config,
  pr: ReviewWorkspacePr,
  deps: ReviewDeps,
  maxPatchBytes: number,
): Promise<ReadShas & { sources: PatchSource[] }> {
  const ready = readyFrom(config, pr, deps);
  const files = await changedFiles(
    ready.runners,
    ready.clonePath,
    ready.mergeBaseSha,
    ready.headSha,
  );
  const bulk = await classifyBulk(
    ready,
    ready.mergeBaseSha,
    ready.headSha,
    files.map((f) => f.path),
  );
  const sources = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      ({ oldSize: _old, newSize: _new, ...file }): PatchSource => ({
        ...file,
        ...bulk.get(file.path),
        read: () =>
          fileDiffCapped(
            ready.runners.search,
            ready.clonePath,
            ready.mergeBaseSha,
            ready.headSha,
            file.path,
            file.oldPath,
            maxPatchBytes + 1,
          ),
      }),
    );
  return { headSha: ready.headSha, mergeBaseSha: ready.mergeBaseSha, sources };
}

// ---------------------------------------------------------------------------
// Setup consent
// ---------------------------------------------------------------------------

/**
 * Allowlisted variables a review's setup script doesn't get, on top of the
 * provider secrets every spawned command is denied. The SSH agent would let a
 * PR's own code authenticate as the user to any host their keys open. Named in
 * the consent prompt, so the user knows a script needing them will fail.
 */
export const SETUP_WITHHELD_ENV = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
] as const;

/**
 * Said in the consent prompt: agreeing runs the PR's code, and only the tests
 * mutation testing runs get a sandbox.
 */
export const SETUP_SANDBOX_NOTES =
  "Agreeing runs this pull request's code on your machine as you. The setup script runs without " +
  "a sandbox, with no provider secrets or SSH agent. Mutation testing later runs its tests in a " +
  "macOS sandbox (loopback-only network, writes only to a scratch copy, no reads of your " +
  "credentials); that is a second line of defence, not a reason to run code you don't trust.";

interface SetupInfo {
  script: string | null;
  author: string | null;
  branch: string | null;
  /** The commit the script would run against; sent back with the answer. */
  headSha: string | null;
  /** Environment variables the script will not be given. */
  withheldEnv: readonly string[];
  /** What runs sandboxed and what doesn't, for the consent prompt to say plainly. */
  sandboxNotes: string;
  consent: "granted" | "declined" | null;
  /** The head commit `consent` was given for; consent for another head no longer applies. */
  consentHeadSha: string | null;
  status: ReviewWorkspacePr["setupStatus"];
  log: string | null;
}

/** What the consent prompt shows: who wrote the PR, its branch and commit, and the exact script. */
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
    headSha: pr.headSha,
    withheldEnv: SETUP_WITHHELD_ENV,
    sandboxNotes: SETUP_SANDBOX_NOTES,
    consent: pr.setupConsent,
    consentHeadSha: pr.setupHeadSha,
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
 * The answer carries the script and the head commit the user was shown, and
 * nothing runs unless both still match: consent is to *that* script against
 * *that* code. An edit to the registered repo's setup, or a push that a
 * refresh picked up, between the prompt and the answer is refused rather than
 * run on the strength of a yes to something else.
 */
export async function answerReviewSetup(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  answer: { grant: boolean; script: string | null; headSha: string | null },
  deps: ReviewDeps,
): Promise<ReviewWorkspacePr> {
  await requireActiveWorkspace(db, workspaceId);
  const pr = await getReviewPr(db, workspaceId, prId);
  if (!answer.grant) {
    return updatePr(db, pr.id, { setupConsent: "declined", setupHeadSha: pr.headSha });
  }

  if (pr.worktreeStatus !== "ready") {
    throw new ReviewWorkspaceError(`the checkout is ${pr.worktreeStatus}, not ready`, 409);
  }
  if (!answer.headSha || answer.headSha !== pr.headSha) {
    throw new ReviewWorkspaceError(
      "the pull request has moved since setup was offered; review it again",
      409,
    );
  }
  const script = await deps.setupScriptFor(pr.ref);
  if (answer.script !== script) {
    throw new ReviewWorkspaceError(
      "the setup script changed since it was shown; review it again",
      409,
    );
  }
  if (!script) {
    return updatePr(db, pr.id, {
      setupConsent: "granted",
      setupHeadSha: pr.headSha,
      setupStatus: "skipped",
    });
  }

  // Claimed before anything is written, so a request that loses the race to a
  // sync (or another yes) is refused without leaving `running` on the row.
  const run = claimRun(pr.id);
  if (!run) throw new ReviewWorkspaceError("this pull request is still being updated", 409);
  let row: ReviewWorkspacePr;
  try {
    row = await updatePr(db, pr.id, {
      setupConsent: "granted",
      setupHeadSha: pr.headSha,
      setupStatus: "running",
      setupLog: null,
    });
  } catch (e) {
    run.finish();
    throw e;
  }
  void runSetup(db, config, pr, script, run);
  return row;
}

async function runSetup(
  db: Db,
  config: Config,
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
    assertWorktreeInWorkspace(config, pr);
    const clonePath = reviewClonePath(config, pr.ref);
    const snapshot = snapshotGitState(clonePath, pr.worktreePath);
    try {
      // The script's environment is the scrubbed one minus the SSH agent: no
      // provider secrets, no git credentials, no way to borrow the user's keys.
      const result = await runSetupScript(
        pr.worktreePath,
        script,
        (text) => run.emit({ type: "log", text }),
        { withoutEnv: SETUP_WITHHELD_ENV },
      );
      logTail = result.logTail;
      status = result.exitCode === 0 ? "succeeded" : "failed";
      if (result.exitCode !== 0) error = `setup script exited ${result.exitCode}`;
    } finally {
      const restored = await withCloneLock(clonePath, async () => restoreGitState(snapshot));
      if (restored.length) {
        run.emit({
          type: "log",
          text: `\nPut back git files the setup script changed: ${restored.join(", ")}\n`,
        });
      }
    }
  } catch (e) {
    error = safeMessage(e);
  }
  run.emit({ type: "done", phase: "setup", status, error });
  await db
    .update(reviewWorkspacePrs)
    .set({ setupStatus: status, setupLog: logTail })
    .where(eq(reviewWorkspacePrs.id, pr.id))
    .catch((err) => console.error("[review-workspaces] failed to record setup:", err))
    .finally(() => run.finish());
}
