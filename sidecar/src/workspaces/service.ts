/**
 * Workspaces service: the repo registry plus provisioning and teardown of the
 * per-workspace worktrees. Git/filesystem work is delegated to `git.ts`; this
 * module owns the database state and orchestration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type IssueLink,
  type Repo,
  repos,
  type Task,
  tasks,
  type Workspace,
  type WorkspaceRepo,
  type WorkspaceRepoPr,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import { deleteLinkForWorkspace, listLinksForWorkspace, upsertLink } from "../issues/service.ts";
import { completeTasksByWorkspace, tasksForWorkspace } from "../tasks/service.ts";
import { stopClaudeSession } from "./claudeSession.ts";
import { runStreaming } from "./exec.ts";
import {
  addExistingBranchWorktree,
  type BranchSync,
  branchExists,
  branchSync,
  type ChangedFile,
  createWorktree,
  defaultGitRunner,
  detectDefaultBranch,
  ensurePrimaryClone,
  fetchBranch,
  fetchRemote,
  fileDiff,
  type GitRunner,
  listChangedFiles,
  listFiles,
  listRemoteBranches,
  removeWorktree,
  updateDefaultBranch,
} from "./git.ts";

const SETUP_LOG_CAP = 16 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Repo registry
// ---------------------------------------------------------------------------

export interface CreateRepoInput {
  cloneUrl: string;
  name?: string;
  setupScript?: string | null;
  runScript?: string | null;
  pullIssues?: boolean;
}

export interface UpdateRepoInput {
  name?: string;
  cloneUrl?: string;
  setupScript?: string | null;
  runScript?: string | null;
  pullIssues?: boolean;
}

/** Extracts {owner, repo} from an ssh or https git remote, or null. */
export function parseGitUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const match = trimmed.match(/[:/]([^/:]+)\/([^/]+)$/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * A clone URL classified by provider. GitHub is addressed by owner/repo; Azure
 * DevOps by org/project/repo. This is the single place the workspace flow learns
 * a repo's provider — the `repos` table stores only the raw clone URL, so the
 * poller and the PR→workspace backlink both parse it here rather than persisting
 * a provider column.
 *
 * Keep in sync with the frontend copy in `src/lib/repos.ts` — the two bundles
 * share no importable module, so both must classify a clone URL identically.
 */
export type RepoRemote =
  | { provider: "github"; owner: string; repo: string }
  | { provider: "azure"; org: string; project: string; repo: string };

/** Hosts that identify an Azure DevOps remote (modern and legacy forms). The
 *  legacy org lives in the subdomain (`{org}.visualstudio.com`), so a bare
 *  `visualstudio.com` is not a real remote host and is intentionally excluded. */
function isAzureHost(host: string): boolean {
  return (
    host === "dev.azure.com" ||
    host === "ssh.dev.azure.com" ||
    host === "vs-ssh.visualstudio.com" ||
    host.endsWith(".visualstudio.com")
  );
}

/** Splits a git remote into its host and path segments, spanning scp-like
 *  (`git@host:path`) and URL (`https://…`, `ssh://…`) forms. */
function splitRemote(url: string): { host: string; segments: string[] } | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  // scp-like syntax (`user@host:path`) has no scheme and a `:` before the path.
  const scp = trimmed.match(/^[^/]+@([^/:]+):(.+)$/);
  const [host, path] = scp
    ? [scp[1]!, scp[2]!]
    : (() => {
        try {
          const u = new URL(trimmed);
          return [u.hostname, u.pathname] as const;
        } catch {
          return ["", ""] as const;
        }
      })();
  if (!host) return null;
  return { host, segments: path.split("/").filter(Boolean) };
}

/**
 * Classifies a clone URL as GitHub or Azure DevOps, extracting the identity each
 * provider's PR lookup needs. Azure DevOps encodes org/project/repo three ways:
 * modern HTTPS `dev.azure.com/{org}/{project}/_git/{repo}`, SSH
 * `ssh.dev.azure.com:v3/{org}/{project}/{repo}`, and legacy
 * `{org}.visualstudio.com/…/{project}/_git/{repo}` (org in the subdomain). Any
 * non-Azure host falls back to GitHub owner/repo. Returns null when unparseable.
 */
export function parseRepoRemote(url: string): RepoRemote | null {
  const parts = splitRemote(url);
  if (!parts) return null;
  const { host, segments } = parts;

  if (isAzureHost(host)) {
    // SSH form: v3/{org}/{project}/{repo}.
    if (segments[0] === "v3" && segments.length >= 4) {
      return { provider: "azure", org: segments[1]!, project: segments[2]!, repo: segments[3]! };
    }
    // HTTPS form: the `_git` marker precedes the repo and follows the project.
    const gitIdx = segments.indexOf("_git");
    if (gitIdx >= 1 && segments.length > gitIdx + 1) {
      // Legacy visualstudio.com carries the org in the subdomain; dev.azure.com
      // carries it as the first path segment.
      const isLegacyVisualStudioHost =
        host === "visualstudio.com" || host.endsWith(".visualstudio.com");
      const org = isLegacyVisualStudioHost ? host.split(".")[0]! : segments[0]!;
      return {
        provider: "azure",
        org,
        project: segments[gitIdx - 1]!,
        repo: segments[gitIdx + 1]!,
      };
    }
    return null;
  }

  const github = parseGitUrl(url);
  return github ? { provider: "github", ...github } : null;
}

/**
 * Allowed clone-URL transports. Git's `ext::`/`fd::` remote helpers execute
 * arbitrary commands, and a leading `-` is read as a flag — both would turn a
 * registry entry into code execution, so only these schemes are accepted.
 */
const ALLOWED_CLONE_URL = /^(https?:\/\/|git:\/\/|ssh:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:)/;

/** Throws if a clone URL uses a transport that could execute arbitrary code. */
export function assertSafeCloneUrl(url: string): void {
  if (!ALLOWED_CLONE_URL.test(url.trim())) {
    throw new Error(`unsupported clone URL transport: ${url}`);
  }
}

/**
 * Throws if a branch name git could misread. The important case is a leading
 * `-`, which git's option parser reads as a flag rather than a ref (the same
 * class of risk `assertSafeCloneUrl` guards against) — so a chosen existing
 * branch can't smuggle a git option into `fetch`/`worktree add`. Also rejects
 * whitespace and the characters git forbids in ref names, so a real remote
 * branch (which the picker offers) always passes.
 */
export function assertSafeBranchName(branch: string): void {
  const trimmed = branch.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git bars control chars in ref names.
  if (!trimmed || trimmed.startsWith("-") || /[\s~^:?*[\\\x00-\x1f]/.test(trimmed)) {
    throw new Error(`unsupported branch name: ${branch}`);
  }
}

/** Absolute path to a repo's primary clone under the workspaces root. */
export function primaryClonePath(config: Config, owner: string, repo: string): string {
  return `${config.workspacesRoot}/.repos/${owner.toLowerCase()}-${repo.toLowerCase()}`;
}

export async function createRepo(db: Db, config: Config, input: CreateRepoInput): Promise<Repo> {
  assertSafeCloneUrl(input.cloneUrl);
  const parsed = parseGitUrl(input.cloneUrl);
  if (!parsed) throw new Error(`could not parse owner/repo from clone URL: ${input.cloneUrl}`);
  const { owner, repo } = parsed;
  const [row] = await db
    .insert(repos)
    .values({
      name: input.name?.trim() || repo,
      owner,
      repo,
      cloneUrl: input.cloneUrl.trim(),
      primaryClonePath: primaryClonePath(config, owner, repo),
      setupScript: input.setupScript ?? null,
      runScript: input.runScript ?? null,
      pullIssues: input.pullIssues ?? false,
    })
    .returning();
  return row!;
}

export async function listRepos(db: Db): Promise<Repo[]> {
  return db.select().from(repos).orderBy(repos.name);
}

export async function getRepo(db: Db, id: string): Promise<Repo | null> {
  const [row] = await db.select().from(repos).where(eq(repos.id, id));
  return row ?? null;
}

export async function updateRepo(db: Db, id: string, patch: UpdateRepoInput): Promise<Repo | null> {
  const values: Partial<typeof repos.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.setupScript !== undefined) values.setupScript = patch.setupScript;
  if (patch.runScript !== undefined) values.runScript = patch.runScript;
  if (patch.pullIssues !== undefined) values.pullIssues = patch.pullIssues;
  if (patch.cloneUrl !== undefined) {
    assertSafeCloneUrl(patch.cloneUrl);
    const parsed = parseGitUrl(patch.cloneUrl);
    if (!parsed) throw new Error(`could not parse owner/repo from clone URL: ${patch.cloneUrl}`);
    values.cloneUrl = patch.cloneUrl.trim();
    values.owner = parsed.owner;
    values.repo = parsed.repo;
  }
  const [row] = await db.update(repos).set(values).where(eq(repos.id, id)).returning();
  return row ?? null;
}

export async function deleteRepo(db: Db, id: string): Promise<boolean> {
  const rows = await db.delete(repos).where(eq(repos.id, id)).returning();
  return rows.length > 0;
}

/**
 * The repo's remote branch names, so a workspace can be created on an existing
 * branch. Ensures the primary clone exists and fetches first (under the repo
 * lock, so it never races a worktree add/remove) so the list is current.
 */
export async function listRepoBranches(
  db: Db,
  repoId: string,
  runner: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const repo = await getRepo(db, repoId);
  if (!repo) throw new Error("repo not found");
  return withRepoLock(repo.id, async () => {
    await ensurePrimaryClone(runner, repo.cloneUrl, repo.primaryClonePath);
    await fetchRemote(runner, repo.primaryClonePath);
    return listRemoteBranches(runner, repo.primaryClonePath);
  });
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface CreateWorkspaceInput {
  name: string;
  /**
   * Repos to build worktrees for. Empty means a *scratch* workspace: just a
   * folder to run Claude in, for experimentation and exploration — no repo,
   * clone, or worktree.
   */
  repoIds: string[];
  /**
   * Per-repo (keyed by repo id) existing branch to check out instead of cutting
   * a fresh branch. A repo absent from this map, or mapped to a blank string,
   * gets the default new-branch flow.
   */
  existingBranches?: Record<string, string>;
  taskId?: string | null;
}

export interface WorkspaceRepoDetail extends WorkspaceRepo {
  repo: Repo;
  pr: WorkspaceRepoPr | null;
}

export interface WorkspaceDetail extends Workspace {
  repos: WorkspaceRepoDetail[];
  tasks: Task[];
  // GitHub/JIRA issues linked to this workspace, via the shared issue-link table.
  issues: IssueLink[];
}

/** Filesystem- and branch-safe slug derived from a workspace name. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "workspace"
  );
}

/** Finds a slug not used by any non-archived workspace, suffixing if needed. */
async function resolveUniqueSlug(db: Db, base: string): Promise<string> {
  const active = await db
    .select({ slug: workspaces.slug })
    .from(workspaces)
    .where(inArray(workspaces.status, ["creating", "active", "archiving", "error"]));
  const taken = new Set(active.map((r) => r.slug));
  if (!taken.has(base)) return base;
  // Cap the search: 1000 same-named active workspaces means something is wrong.
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique workspace slug");
}

/**
 * Creates a workspace and its repo rows in the DB. Does NOT touch the
 * filesystem — provisioning (clone/fetch/worktree/setup) is driven separately
 * via `provisionWorkspace` so its output can be streamed to the UI.
 */
export async function createWorkspace(
  db: Db,
  config: Config,
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  // No repos is allowed: that's a scratch workspace (just a folder).
  const selected = input.repoIds.length
    ? await db.select().from(repos).where(inArray(repos.id, input.repoIds))
    : [];
  if (selected.length !== input.repoIds.length) {
    throw new Error("one or more repos not found");
  }

  const slug = await resolveUniqueSlug(db, slugify(input.name));
  const rootPath = `${config.workspacesRoot}/${slug}`;
  const branch = `yarvis/${slug}`;

  // Distinct subfolder per repo; disambiguate name collisions with the owner.
  const nameCounts = new Map<string, number>();
  for (const repo of selected) {
    const lowerName = repo.name.toLowerCase();
    nameCounts.set(lowerName, (nameCounts.get(lowerName) ?? 0) + 1);
  }

  // One transaction so a mid-create failure never leaves a half-built workspace.
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: input.name.trim(), slug, rootPath, status: "creating" })
      .returning();

    // A scratch workspace has no repo rows; skip the insert (Drizzle rejects an
    // empty values array).
    if (selected.length) {
      await tx.insert(workspaceRepos).values(
        selected.map((repo) => {
          const existing = input.existingBranches?.[repo.id]?.trim();
          if (existing) assertSafeBranchName(existing);
          return {
            workspaceId: workspace!.id,
            repoId: repo.id,
            branch: existing || branch,
            existingBranch: Boolean(existing),
            baseBranch: repo.defaultBranch ?? "main",
            worktreePath: `${rootPath}/${
              (nameCounts.get(repo.name.toLowerCase()) ?? 0) > 1
                ? `${repo.name.toLowerCase()}-${repo.owner.toLowerCase()}`
                : repo.name.toLowerCase()
            }`,
          };
        }),
      );
    }

    if (input.taskId) {
      await tx.update(tasks).set({ workspaceId: workspace!.id }).where(eq(tasks.id, input.taskId));
    }

    return workspace!;
  });
}

export interface WorkspaceSummary extends Workspace {
  /** Names of the repos in this workspace, for grouping in the sidebar. */
  repoNames: string[];
}

export async function listWorkspaces(db: Db): Promise<WorkspaceSummary[]> {
  const wsRows = await db.select().from(workspaces).orderBy(workspaces.createdAt);
  if (!wsRows.length) return [];

  const memberships = await db
    .select({ workspaceId: workspaceRepos.workspaceId, name: repos.name })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id));
  const namesByWorkspace = new Map<string, string[]>();
  for (const m of memberships) {
    const names = namesByWorkspace.get(m.workspaceId) ?? [];
    names.push(m.name);
    namesByWorkspace.set(m.workspaceId, names);
  }

  return wsRows.map((w) => ({ ...w, repoNames: namesByWorkspace.get(w.id) ?? [] }));
}

export async function getWorkspace(db: Db, id: string): Promise<WorkspaceDetail | null> {
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, id));
  if (!workspace) return null;

  const wrRows = await db
    .select()
    .from(workspaceRepos)
    .where(eq(workspaceRepos.workspaceId, id))
    .orderBy(workspaceRepos.createdAt);

  const repoIds = wrRows.map((r) => r.repoId);
  const repoRows = repoIds.length
    ? await db.select().from(repos).where(inArray(repos.id, repoIds))
    : [];
  const repoById = new Map(repoRows.map((r) => [r.id, r]));

  const wrIds = wrRows.map((r) => r.id);
  const prRows = wrIds.length
    ? await db.select().from(workspaceRepoPr).where(inArray(workspaceRepoPr.workspaceRepoId, wrIds))
    : [];
  const prByWr = new Map(prRows.map((p) => [p.workspaceRepoId, p]));

  return {
    ...workspace,
    repos: wrRows.map((wr) => ({
      ...wr,
      repo: repoById.get(wr.repoId)!,
      pr: prByWr.get(wr.id) ?? null,
    })),
    tasks: await tasksForWorkspace(db, id),
    issues: await listLinksForWorkspace(db, id),
  };
}

/** Links a task to a workspace; archiving the workspace will complete it.
 *  Returns false if the task doesn't exist. */
export async function linkTask(db: Db, workspaceId: string, taskId: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ workspaceId })
    .where(eq(tasks.id, taskId))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

/** Detaches a task from a workspace; scoped so it only affects this workspace's
 *  task. Returns false if no such linked task exists. */
export async function unlinkTask(db: Db, workspaceId: string, taskId: string): Promise<boolean> {
  const rows = await db
    .update(tasks)
    .set({ workspaceId: null })
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)))
    .returning({ id: tasks.id });
  return rows.length > 0;
}

export interface LinkIssueInput {
  provider: string;
  sourceKey: string;
  externalId: string;
  title?: string | null;
  url?: string | null;
}

/** Links a GitHub/JIRA issue to a workspace via the shared issue-link table.
 *  Idempotent per issue: re-linking re-points the issue at this workspace.
 *  Returns null if the workspace doesn't exist (parity with `linkTask`), rather
 *  than letting the issue_links FK surface a raw constraint error. */
export async function linkIssue(
  db: Db,
  workspaceId: string,
  input: LinkIssueInput,
): Promise<IssueLink | null> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  if (!ws) return null;
  return upsertLink(db, { ...input, workspaceId, localStatus: "in_progress" });
}

/** Detaches an issue from a workspace; scoped so it only affects this
 *  workspace's link. Returns false if no such linked issue exists. */
export function unlinkIssue(
  db: Db,
  workspaceId: string,
  provider: string,
  sourceKey: string,
  externalId: string,
): Promise<boolean> {
  return deleteLinkForWorkspace(db, workspaceId, provider, sourceKey, externalId);
}

async function getWorkspaceRepo(db: Db, workspaceRepoId: string): Promise<WorkspaceRepo> {
  const [row] = await db
    .select()
    .from(workspaceRepos)
    .where(eq(workspaceRepos.id, workspaceRepoId));
  if (!row) throw new Error("workspace repo not found");
  return row;
}

/** All tracked files in a workspace repo's worktree. */
export async function workspaceRepoFiles(
  db: Db,
  workspaceRepoId: string,
  runner: GitRunner = defaultGitRunner,
): Promise<string[]> {
  const wr = await getWorkspaceRepo(db, workspaceRepoId);
  return listFiles(runner, wr.worktreePath);
}

/** Files changed on a workspace repo's branch versus its base. */
export async function workspaceRepoChanges(
  db: Db,
  workspaceRepoId: string,
  runner: GitRunner = defaultGitRunner,
): Promise<ChangedFile[]> {
  const wr = await getWorkspaceRepo(db, workspaceRepoId);
  return listChangedFiles(runner, wr.worktreePath, wr.baseBranch);
}

/** The unified-diff patch for one changed file in a workspace repo's worktree. */
export async function workspaceRepoFileDiff(
  db: Db,
  workspaceRepoId: string,
  path: string,
  runner: GitRunner = defaultGitRunner,
): Promise<{ path: string; patch: string }> {
  const wr = await getWorkspaceRepo(db, workspaceRepoId);
  const patch = await fileDiff(runner, wr.worktreePath, wr.baseBranch, path);
  return { path, patch };
}

export interface WorkspaceRepoSync extends BranchSync {
  /** Set when the pre-count fetch failed (offline, auth); counts are then
   *  last-known rather than current. */
  fetchError: string | null;
}

/**
 * Push/pull divergence for a workspace repo's branch. Fetches the remote first
 * (under the repo lock, so it never races a worktree add/remove) so the counts
 * are current; a fetch failure is reported but still returns the last-known
 * counts from the local refs.
 */
export async function workspaceRepoSync(
  db: Db,
  workspaceRepoId: string,
  runner: GitRunner = defaultGitRunner,
): Promise<WorkspaceRepoSync> {
  const wr = await getWorkspaceRepo(db, workspaceRepoId);
  const [repo] = await db.select().from(repos).where(eq(repos.id, wr.repoId));
  if (!repo) throw new Error("repo not found");

  let fetchError: string | null = null;
  try {
    await withRepoLock(wr.repoId, () => fetchRemote(runner, repo.primaryClonePath));
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e);
  }

  const sync = await branchSync(runner, wr.worktreePath, wr.branch, wr.baseBranch);
  return { ...sync, fetchError };
}

/** A workspace the PR view can link back to, keyed by a cached PR match. */
export interface WorkspaceForPr {
  id: string;
  name: string;
  slug: string;
  status: Workspace["status"];
}

/**
 * A PR identity the backlink matches against, tagged by provider so GitHub
 * (owner/repo) and Azure DevOps (org/project/repo) are compared on the right
 * fields. `number` is the PR number for GitHub and the pull-request id for Azure
 * — both are stored in the same cached `prNumber` column.
 */
export type PrLocator =
  | { provider: "github"; owner: string; repo: string; number: number }
  | { provider: "azure"; org: string; project: string; repo: string; number: number };

/** Case-folded equality, matching how both providers treat these identifiers. */
function eqFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** True when a repo's parsed clone URL is the same repo the locator names. The
 *  provider is already equal after the first guard; each branch re-checks both
 *  sides only so TypeScript narrows the union on `remote` and `locator` together
 *  (the final `return false` is likewise unreachable but required for that). */
function remoteMatchesLocator(remote: RepoRemote | null, locator: PrLocator): boolean {
  if (!remote || remote.provider !== locator.provider) return false;
  if (remote.provider === "github" && locator.provider === "github") {
    return eqFold(remote.owner, locator.owner) && eqFold(remote.repo, locator.repo);
  }
  if (remote.provider === "azure" && locator.provider === "azure") {
    return (
      eqFold(remote.org, locator.org) &&
      eqFold(remote.project, locator.project) &&
      eqFold(remote.repo, locator.repo)
    );
  }
  return false;
}

/**
 * Finds a non-archived workspace whose repo raised the given PR, matched through
 * the poller's PR cache. The cache row carries only the PR number, so candidates
 * are narrowed by number in SQL and then confirmed by parsing each repo's clone
 * URL — this keeps the match provider-aware (GitHub owner/repo, Azure
 * org/project/repo) without a provider column on `repos`.
 */
export async function findWorkspaceForPr(
  db: Db,
  locator: PrLocator,
): Promise<WorkspaceForPr | null> {
  const candidates = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      status: workspaces.status,
      cloneUrl: repos.cloneUrl,
    })
    .from(workspaceRepoPr)
    .innerJoin(workspaceRepos, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .where(and(eq(workspaceRepoPr.prNumber, locator.number), ne(workspaces.status, "archived")));

  for (const { cloneUrl, ...ws } of candidates) {
    if (remoteMatchesLocator(parseRepoRemote(cloneUrl), locator)) return ws;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export type ProvisionEvent =
  | { type: "repo-start"; workspaceRepoId: string; repo: string }
  | { type: "log"; workspaceRepoId: string; text: string }
  | { type: "repo-done"; workspaceRepoId: string; status: string; exitCode?: number }
  | { type: "repo-error"; workspaceRepoId: string; message: string }
  | { type: "done"; status: string }
  | { type: "error"; message: string };

export type ProvisionEmit = (event: ProvisionEvent) => void | Promise<void>;

/** Serializes mutations to a repo's primary clone across concurrent workspaces. */
const repoLocks = new Map<string, Promise<unknown>>();

async function withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoId) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  // Store a never-rejecting tail so a failure doesn't poison the chain.
  repoLocks.set(
    repoId,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** Workspaces currently being provisioned, to reject concurrent drives. */
const provisioning = new Set<string>();

/**
 * (Re)writes AGENTS.md and CLAUDE.md at the workspace root. Claude is started
 * in the workspace root rather than inside a single repo — so it can work
 * across every repo checked out there — but that's not its usual layout, and
 * without help it can assume the workspace root itself is the project. These
 * files spell out which repos are present, where, and on what branch.
 * Best-effort: a write failure is logged but must not fail provisioning.
 */
function writeContextFiles(detail: WorkspaceDetail): void {
  const lines = [
    `# Workspace: ${detail.name}`,
    "",
    "This is a Yarvis workspace. Claude is started here, in the workspace root,",
    "rather than inside a single repo, so it can work across every repo listed",
    "below in one session. Each repo is already cloned and checked out on its",
    "own branch — there's no need to clone or switch branches.",
    "",
    "## Repos",
    "",
    ...detail.repos.map((wr) => {
      const path = relative(detail.rootPath, wr.worktreePath) || ".";
      return `- **${wr.repo.name}** (${wr.repo.owner}/${wr.repo.repo}): \`${path}\`, checked out on branch \`${wr.branch}\` (base \`${wr.baseBranch}\`)`;
    }),
  ];

  if (detail.tasks.length > 0) {
    lines.push("", "## Associated tasks", "");
    for (const task of detail.tasks) {
      lines.push(`- ${task.title}${task.notes ? `: ${task.notes}` : ""}`);
    }
  }

  lines.push("");

  try {
    writeFileSync(`${detail.rootPath}/AGENTS.md`, lines.join("\n"));
    writeFileSync(`${detail.rootPath}/CLAUDE.md`, "@AGENTS.md");
  } catch (e) {
    console.error("[workspaces] failed to write AGENTS.md/CLAUDE.md:", e);
  }
}

/**
 * Drives provisioning for a workspace: per repo, ensure the primary clone,
 * refresh its default branch, cut a worktree, and run the setup script —
 * emitting progress events (setup output streams through `emit`). Idempotent
 * enough to retry: a repo already `ready`/`removed` is skipped.
 */
export async function provisionWorkspace(
  db: Db,
  id: string,
  emit: ProvisionEmit,
  runner: GitRunner = defaultGitRunner,
): Promise<void> {
  if (provisioning.has(id)) {
    await emit({ type: "error", message: "workspace is already being provisioned" });
    return;
  }
  provisioning.add(id);
  // Repos provision in parallel, so serialize emits: concurrent stream writes
  // would otherwise interleave bytes within a single SSE frame.
  let emitChain: Promise<void> = Promise.resolve();
  const safeEmit: ProvisionEmit = (event) => {
    emitChain = emitChain.then(() => emit(event));
    return emitChain;
  };

  try {
    const detail = await getWorkspace(db, id);
    if (!detail) {
      await safeEmit({ type: "error", message: "workspace not found" });
      return;
    }

    // A scratch workspace (no repos) has no worktree to cut its root folder as a
    // side effect, so create it explicitly here.
    if (detail.repos.length === 0) {
      mkdirSync(detail.rootPath, { recursive: true });
    }

    const provisionRepo = async (wr: WorkspaceRepoDetail): Promise<void> => {
      if (wr.status === "ready" || wr.status === "removed") return;
      await safeEmit({ type: "repo-start", workspaceRepoId: wr.id, repo: wr.repo.name });
      await db
        .update(workspaceRepos)
        .set({ status: "provisioning", error: null })
        .where(eq(workspaceRepos.id, wr.id));

      try {
        await withRepoLock(wr.repoId, async () => {
          const repo = wr.repo;
          await ensurePrimaryClone(runner, repo.cloneUrl, repo.primaryClonePath);

          const detected = await detectDefaultBranch(runner, repo.primaryClonePath);
          const base = detected ?? repo.defaultBranch ?? "main";
          if (detected && detected !== repo.defaultBranch) {
            await db
              .update(repos)
              .set({ defaultBranch: detected, updatedAt: new Date() })
              .where(eq(repos.id, repo.id));
          }

          await updateDefaultBranch(runner, repo.primaryClonePath, base);

          if (wr.existingBranch) {
            // Check out the branch the user chose as-is; `base` still stands as
            // the diff base so changes show against the default branch.
            await fetchBranch(runner, repo.primaryClonePath, wr.branch);
            await addExistingBranchWorktree(
              runner,
              repo.primaryClonePath,
              wr.worktreePath,
              wr.branch,
            );
            await db
              .update(workspaceRepos)
              .set({ baseBranch: base })
              .where(eq(workspaceRepos.id, wr.id));
          } else {
            // Avoid colliding with a branch left behind by a prior workspace.
            let branch = wr.branch;
            if (await branchExists(runner, repo.primaryClonePath, branch)) {
              branch = `${wr.branch}-${id.slice(0, 8)}`;
            }
            await createWorktree(runner, repo.primaryClonePath, wr.worktreePath, branch, base);
            await db
              .update(workspaceRepos)
              .set({ branch, baseBranch: base })
              .where(eq(workspaceRepos.id, wr.id));
          }
        });

        let exitCode = 0;
        if (wr.repo.setupScript?.trim()) {
          // `bash -c`, not `-lc`: a login shell would source the user's profile
          // and re-import the provider secrets exec.ts deliberately stripped.
          let logTail = "";
          exitCode = await runStreaming(["bash", "-c", wr.repo.setupScript], {
            cwd: wr.worktreePath,
            timeoutMs: SETUP_TIMEOUT_MS,
            onChunk: async (text) => {
              logTail = (logTail + text).slice(-SETUP_LOG_CAP);
              await safeEmit({ type: "log", workspaceRepoId: wr.id, text });
            },
          });
          await db
            .update(workspaceRepos)
            .set({ setupLog: logTail, setupExitCode: exitCode })
            .where(eq(workspaceRepos.id, wr.id));
        }

        if (exitCode !== 0) {
          const message = `setup script exited ${exitCode}`;
          await db
            .update(workspaceRepos)
            .set({ status: "error", error: message })
            .where(eq(workspaceRepos.id, wr.id));
          await safeEmit({ type: "repo-error", workspaceRepoId: wr.id, message });
        } else {
          await db
            .update(workspaceRepos)
            .set({ status: "ready" })
            .where(eq(workspaceRepos.id, wr.id));
          await safeEmit({ type: "repo-done", workspaceRepoId: wr.id, status: "ready", exitCode });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await db
          .update(workspaceRepos)
          .set({ status: "error", error: message })
          .where(eq(workspaceRepos.id, wr.id));
        await safeEmit({ type: "repo-error", workspaceRepoId: wr.id, message });
      }
    };

    // Distinct repos provision concurrently; withRepoLock still serializes work
    // on a primary clone shared with another workspace.
    await Promise.all(detail.repos.map(provisionRepo));

    // The workspace is active only if every repo provisioned cleanly.
    const after = await getWorkspace(db, id);
    if (after) writeContextFiles(after);
    const allReady = after?.repos.every((r) => r.status === "ready" || r.status === "removed");
    const status = allReady ? "active" : "error";
    await db
      .update(workspaces)
      .set({ status, updatedAt: new Date(), error: allReady ? null : "one or more repos failed" })
      .where(eq(workspaces.id, id));
    await safeEmit({ type: "done", status });
  } finally {
    provisioning.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Archival
// ---------------------------------------------------------------------------

export interface ArchiveWorkspaceInput {
  summary?: string | null;
  mergedPrUrl?: string | null;
  /** Discard uncommitted work in the worktrees. */
  force?: boolean;
}

export interface ArchiveResult {
  status: Workspace["status"];
  errors: { repo: string; message: string }[];
  /** Number of linked tasks completed (only when fully archived). */
  completedTasks: number;
}

/**
 * The URL of a PR raised from this workspace, so archival can record it even
 * when the PR hasn't merged yet. Prefers a merged PR (the landed change) and
 * otherwise falls back to a still-open one; a closed PR is an abandoned change,
 * so it's never treated as the workspace's outcome.
 */
function linkedPrUrl(detail: WorkspaceDetail): string | null {
  const withPr = detail.repos.filter((r) => r.pr?.prUrl && r.pr.prState !== "closed");
  const merged = withPr.find((r) => r.pr?.prState === "merged");
  return (merged ?? withPr[0])?.pr?.prUrl ?? null;
}

/**
 * Tears down a workspace's worktrees and marks it archived. Idempotent and
 * partial-failure safe: a repo whose worktree won't remove (e.g. uncommitted
 * changes without `force`) keeps the workspace in `archiving` with the error
 * recorded, so the operation can be retried.
 */
export async function archiveWorkspace(
  db: Db,
  id: string,
  input: ArchiveWorkspaceInput = {},
  runner: GitRunner = defaultGitRunner,
): Promise<ArchiveResult> {
  const detail = await getWorkspace(db, id);
  if (!detail) throw new Error("workspace not found");

  // Stop any remote-control Claude session first so it isn't holding the
  // worktree while we remove it. Best-effort: the core may be unreachable.
  try {
    await stopClaudeSession(id);
  } catch (e) {
    console.warn("[workspaces] failed to stop Claude session on archive:", e);
  }

  await db
    .update(workspaces)
    .set({ status: "archiving", updatedAt: new Date() })
    .where(eq(workspaces.id, id));

  const errors: { repo: string; message: string }[] = [];

  for (const wr of detail.repos) {
    if (wr.status === "removed") continue;
    try {
      await withRepoLock(wr.repoId, () =>
        removeWorktree(runner, wr.repo.primaryClonePath, wr.worktreePath, {
          force: input.force ?? false,
        }),
      );
      await db
        .update(workspaceRepos)
        .set({ status: "removed", error: null })
        .where(eq(workspaceRepos.id, wr.id));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      errors.push({ repo: wr.repo.name, message });
      await db
        .update(workspaceRepos)
        .set({ status: "error", error: message })
        .where(eq(workspaceRepos.id, wr.id));
    }
  }

  const fullyRemoved = errors.length === 0;
  const status: Workspace["status"] = fullyRemoved ? "archived" : "archiving";
  await db
    .update(workspaces)
    .set({
      status,
      summary: input.summary ?? detail.summary,
      mergedPrUrl: input.mergedPrUrl ?? detail.mergedPrUrl ?? linkedPrUrl(detail),
      error: fullyRemoved ? null : "one or more worktrees could not be removed",
      archivedAt: fullyRemoved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, id));

  // Completing the work means the linked task is done — but only once the
  // workspace is fully torn down, so a partial archive stays reopenable.
  const completedTasks = fullyRemoved ? await completeTasksByWorkspace(db, id) : [];

  return { status, errors, completedTasks: completedTasks.length };
}
