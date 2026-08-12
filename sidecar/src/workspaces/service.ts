/**
 * Workspaces service: the repo registry plus provisioning and teardown of the
 * per-workspace worktrees. Git/filesystem work is delegated to `git.ts`; this
 * module owns the database state and orchestration.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { and, eq, getTableColumns, inArray, isNotNull, ne } from "drizzle-orm";
import { publish } from "../attention/hub.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
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
import {
  deleteLinkForWorkspace,
  listLinksForWorkspace,
  sanitizeIssueText,
  upsertLink,
  writeIssuePrompt,
} from "../issues/service.ts";
import { completeTasksByWorkspace, tasksForWorkspace } from "../tasks/service.ts";
import {
  type ClaudeSessionStarter,
  startClaudeSession,
  stopClaudeSession,
} from "./claudeSession.ts";
import { writeClaudeSettings } from "./claudeSettings.ts";
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
import { writeMcpConfig } from "./mcpConfig.ts";

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
  /**
   * The "Start work" prompt for this workspace. Stored on the row so
   * provisioning can write it to `.yarvis/issue-prompt.md` itself and the agent
   * launch survives the UI navigating away — see `workspaces.pendingIssuePrompt`.
   */
  issuePrompt?: string | null;
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

  // Sanitized here rather than at each caller so every producer (issues, JIRA,
  // tasks) gets the same defense against hidden instructions surviving into the
  // auto-approved agent session. Sanitizing sanitized text is a no-op.
  const pendingIssuePrompt = input.issuePrompt?.trim()
    ? sanitizeIssueText(input.issuePrompt)
    : null;

  // One transaction so a mid-create failure never leaves a half-built workspace.
  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: input.name.trim(), slug, rootPath, status: "creating", pendingIssuePrompt })
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

/**
 * A workspace list row. Everything on the workspace except the pending kick-off
 * prompt, which holds a whole ticket body and is wanted only by the one
 * workspace being opened — this list is polled, and for every workspace at once.
 */
export interface WorkspaceSummary extends Omit<Workspace, "pendingIssuePrompt"> {
  /** Names of the repos in this workspace, for grouping in the sidebar. */
  repoNames: string[];
}

export async function listWorkspaces(db: Db): Promise<WorkspaceSummary[]> {
  const { pendingIssuePrompt: _omitted, ...listColumns } = getTableColumns(workspaces);
  const wsRows = await db.select(listColumns).from(workspaces).orderBy(workspaces.createdAt);
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

/**
 * How many progress events a run keeps for replay. Setup-script output can be
 * long, so a late subscriber gets the tail rather than the whole log — enough to
 * see what is happening now without buffering a build's worth of output per run.
 */
const PROVISION_HISTORY_CAP = 500;

export interface ProvisionOptions {
  runner?: GitRunner;
  /** How the kick-off session is started. Injectable so provisioning is testable
   *  without the Rust core on the other end of the control channel. */
  startSession?: ClaudeSessionStarter;
  /**
   * Launch the kick-off session with Remote Control. Off by default: a kick-off
   * started at the machine opens in a tab the user is on their way to. The chat
   * agent turns it on when the request came from somewhere the user isn't.
   */
  remoteControl?: boolean;
  /** Stops *following* an in-flight run when the caller's stream goes away. It
   *  never cancels the run itself — finishing without an audience is the point. */
  signal?: AbortSignal;
}

/** A provisioning run in flight, with what it takes for a second caller to
 *  follow along rather than be turned away. */
interface ProvisionRun {
  /** Recent events, replayed to a subscriber that joined mid-run. */
  history: ProvisionEvent[];
  /**
   * Everyone being served this run. Mixed on purpose: whoever started it is
   * subscribed directly, so its writes are awaited and its backpressure reaches
   * the setup script; followers go through `followProvision`, which queues
   * instead of returning a promise, so they never gate the run.
   */
  subscribers: Set<ProvisionEmit>;
  /** Resolves when the run has emitted its terminal event. */
  finished: Promise<void>;
}

/** Provisioning runs in flight, keyed by workspace id. */
const provisioning = new Map<string, ProvisionRun>();

/**
 * Follows a provisioning run already in flight: replays its recent progress,
 * then streams the rest until it ends. This is what makes a kicked-off workspace
 * resumable — reopening its view while provisioning runs re-drives the same
 * endpoint, and turning that second drive into an error (as rejecting it would)
 * collapses the view the user just came back to.
 */
async function followProvision(
  run: ProvisionRun,
  emit: ProvisionEmit,
  signal?: AbortSignal,
): Promise<void> {
  // Deliveries queue on a chain, which is what keeps the replay ahead of the
  // live events that arrive while it is still flushing. The chain never rejects
  // and the run never waits on it: whoever started the run is the consumer whose
  // backpressure matters, and a follower whose stream has closed must neither
  // poison its own queue nor hold up the run for everyone else.
  let chain: Promise<void> = Promise.resolve();
  const ordered: ProvisionEmit = (event) => {
    chain = chain.then(() => emit(event)).catch(() => undefined);
  };
  // Snapshot and subscribe in one synchronous step, so an event emitted
  // meanwhile is neither missed nor delivered twice. `safeEmit` holds up its end
  // by recording and fanning out in one step of its own.
  const replay = [...run.history];
  run.subscribers.add(ordered);
  for (const event of replay) ordered(event);
  try {
    // Detaching on abort matters because a run can outlive many followers: the
    // workspace view re-drives provisioning every time it is reopened, and Hono
    // swallows writes to a closed stream, so a departed follower is otherwise
    // indistinguishable from a live one and would be served every remaining
    // event for the rest of the run.
    await Promise.race([run.finished, aborted(signal)]);
  } finally {
    // Detach before draining, not after: on the abort path everything still
    // queued is headed for a closed stream, and staying subscribed while it
    // drains is the very thing this is here to stop.
    run.subscribers.delete(ordered);
  }
  await chain;
}

/**
 * Resolves when `signal` aborts, or never when there is nothing to wait on.
 * The listener outlives the race when the run wins it — harmless because these
 * signals are per-request and collected with the response, which is the only
 * caller this has.
 */
function aborted(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

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
 * enough to retry: a repo already `ready`/`removed` is skipped. A call made
 * while a run is already in flight follows that run instead of starting a
 * second one, and `signal` detaches that follower without disturbing the run.
 */
export async function provisionWorkspace(
  db: Db,
  id: string,
  emit: ProvisionEmit,
  {
    runner = defaultGitRunner,
    signal,
    startSession = startClaudeSession,
    remoteControl = false,
  }: ProvisionOptions = {},
): Promise<void> {
  const inFlight = provisioning.get(id);
  if (inFlight) return followProvision(inFlight, emit, signal);

  const { promise: finished, resolve: settle } = Promise.withResolvers<void>();
  const run: ProvisionRun = { history: [], subscribers: new Set([emit]), finished };
  provisioning.set(id, run);

  // Repos provision in parallel, so serialize emits: concurrent stream writes
  // would otherwise interleave bytes within a single SSE frame. A subscriber's
  // failure is swallowed rather than propagated — a stream that closed when its
  // reader went away is not the run's problem to fail over.
  let emitChain: Promise<void> = Promise.resolve();
  const safeEmit: ProvisionEmit = (event) => {
    emitChain = emitChain.then(async () => {
      // Recording for replay and snapshotting the subscribers must stay a single
      // synchronous step: an await between them is a window in which a joining
      // subscriber (see `followProvision`) either misses this event or gets it
      // twice.
      run.history.push(event);
      if (run.history.length > PROVISION_HISTORY_CAP) run.history.shift();
      const subscribers = [...run.subscribers];
      await Promise.all(
        subscribers.map((subscriber) =>
          Promise.resolve()
            .then(() => subscriber(event))
            .catch(() => undefined),
        ),
      );
    });
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
    if (after) {
      writeContextFiles(after);
      writeClaudeSettings(
        after.rootPath,
        after.id,
        after.repos.map((wr) => wr.worktreePath),
      );
      writeMcpConfig(after.rootPath);
    }
    const allReady = after?.repos.every((r) => r.status === "ready" || r.status === "removed");
    let status: Workspace["status"] = allReady ? "active" : "error";
    let error = allReady ? null : "one or more repos failed";

    // Finish the "Start work" kick-off before reporting the workspace active,
    // so by the time anything can see it there is already a session to attach
    // to. Doing it here rather than in the caller is what frees the flow from
    // whoever started it: seeding the prompt file and launching the agent are
    // the last two steps of provisioning, not a UI's follow-up.
    const pendingPrompt = after?.pendingIssuePrompt;
    if (status === "active" && after && pendingPrompt) {
      try {
        await writeIssuePrompt(after.rootPath, pendingPrompt);
      } catch (e) {
        status = "error";
        error = `could not write the issue prompt file: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // Launch before the status flips, so a workspace is never reported ready
    // with its kick-off still owed a session — whoever looks next just attaches.
    if (status === "active" && after && pendingPrompt) {
      await launchKickOffSession(db, after, startSession, remoteControl);
    }

    await db
      .update(workspaces)
      .set({ status, updatedAt: new Date(), error })
      .where(eq(workspaces.id, id));
    await safeEmit({ type: "done", status });
  } catch (e) {
    // Reported rather than rethrown, so every subscriber gets the same terminal
    // event — only the caller that threw would otherwise learn the outcome, and
    // a follower's stream would just end. Recording the failure on the row is
    // what turns the workspace's button into a retry instead of leaving it stuck
    // in `creating`.
    const message = e instanceof Error ? e.message : String(e);
    // Emit before recording. A failed database write is the likeliest way to
    // land here, so writing first would throw again and cost every subscriber
    // the terminal event this block exists to deliver.
    await safeEmit({ type: "error", message });
    await db
      .update(workspaces)
      .set({ status: "error", updatedAt: new Date(), error: message })
      .where(eq(workspaces.id, id))
      // The status is a convenience — it turns the workspace's button into a
      // retry. The event above is what callers actually wait on.
      .catch(() => undefined);
  } finally {
    provisioning.delete(id);
    settle();
  }
}

/**
 * What a "Start work" session is told to do. The ticket itself is written to a
 * known file under the workspace root, so a fixed instruction to read that file
 * is enough and a body of any size stays off the command line.
 */
export const AGENT_ISSUE_INSTRUCTION =
  "Read the ticket details in .yarvis/issue-prompt.md and implement a first pass at the ticket, following the repository's conventions.";

/**
 * Launches the session a kick-off has been waiting for and drops the prompt that
 * recorded it was owed. Best-effort by design: the workspace is provisioned and
 * usable either way, so a launch failure (commonly: the agent isn't logged in)
 * leaves the prompt in place for `resumeKickOffs` to retry rather than failing
 * the workspace. Retrying is safe — the core keys sessions by workspace and
 * discards a spawn for an id that already has one.
 */
async function launchKickOffSession(
  db: Db,
  detail: WorkspaceDetail,
  startSession: ClaudeSessionStarter,
  remoteControl: boolean,
): Promise<void> {
  try {
    await startSession({
      workspaceId: detail.id,
      cwd: detail.rootPath,
      name: detail.name,
      remoteControl,
      instruction: AGENT_ISSUE_INSTRUCTION,
    });
  } catch (e) {
    console.error("[workspaces] could not start the kick-off session:", e);
    return;
  }
  await clearPendingIssuePrompt(db, detail.id).catch(() => undefined);
}

/**
 * Drops a workspace's pending "Start work" prompt, once its session has been
 * launched on the ticket. Until then the prompt stays put, which is what lets an
 * interrupted kick-off resume.
 */
export async function clearPendingIssuePrompt(db: Db, id: string): Promise<void> {
  await db
    .update(workspaces)
    .set({ pendingIssuePrompt: null, updatedAt: new Date() })
    .where(eq(workspaces.id, id));
}

/**
 * Starts a workspace's kick-off running in the background and returns at once.
 * "Start work" answers as soon as the workspace and its issue link exist, because
 * cloning and a setup script take minutes and nothing downstream should wait on
 * them: provisioning, seeding the prompt file, and launching the session all
 * finish here whether or not anyone is still looking at the screen that asked.
 * Progress is watchable meanwhile via the provision stream, which joins the run
 * already going.
 */
export function startKickOff(db: Db, id: string): void {
  void provisionWorkspace(db, id, () => undefined).catch((e) =>
    console.error(`[workspaces] kick-off failed for ${id}:`, e),
  );
}

/**
 * Resumes kick-offs stranded by a sidecar restart: any workspace still holding a
 * prompt is one whose session was never launched. Provisioning is idempotent, so
 * this re-drives it whatever state the workspace stopped in. Called once at
 * startup — nothing else can strand one, since the sequence otherwise runs to
 * completion in the background regardless of what the UI is doing.
 */
export async function resumeKickOffs(db: Db, options: ProvisionOptions = {}): Promise<void> {
  const stranded = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.pendingIssuePrompt), ne(workspaces.status, "archived")));
  if (!stranded.length) return;
  console.warn(`[workspaces] resuming ${stranded.length} interrupted kick-off(s)`);
  for (const { id } of stranded) {
    await provisionWorkspace(db, id, () => undefined, options).catch((e) =>
      console.error(`[workspaces] could not resume kick-off for ${id}:`, e),
    );
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

/** Teardowns in flight, keyed by workspace id, so a second request joins the
 *  running archive instead of racing it over the same worktrees. */
const archivals = new Map<string, Promise<ArchiveResult>>();

/** Keeps a long git error from filling the attention row. */
const ARCHIVE_ERROR_BODY_CAP = 500;

/**
 * Raises a failed archive on the attention stream. The teardown runs in the
 * background, so by the time it stops on a worktree it can't remove there may
 * be nothing on screen to show the error — this is what tells the user their
 * archive didn't finish. Session-less on purpose: an item with no session
 * clears itself once the user opens the workspace, which is where the retry
 * (and the git error) lives. Best-effort; the archive's own outcome stands
 * whether or not the flag goes up.
 */
async function raiseArchiveFailure(
  db: Db,
  detail: WorkspaceDetail,
  errors: { repo: string; message: string }[],
): Promise<void> {
  const summary = errors.length
    ? errors.map((e) => `${e.repo}: ${e.message}`).join("; ")
    : "the worktrees could not be removed";
  try {
    const item = await createAttention(db, {
      source: "system",
      workspaceId: detail.id,
      kind: "error",
      title: detail.name,
      body: `Archive stopped — ${summary}`.slice(0, ARCHIVE_ERROR_BODY_CAP),
      navTarget: { type: "workspace", workspaceId: detail.id },
      payload: { archiveErrors: errors },
    });
    publish(item);
  } catch (e) {
    console.error("[workspaces] failed to raise archive attention:", e);
  }
}

/**
 * Marks the workspace `archiving` and records the summary/PR URL up front, so a
 * caller that doesn't wait for the teardown still sees the new state. Returns
 * the detail read before the flip, which the teardown works from.
 */
async function beginArchive(
  db: Db,
  id: string,
  input: ArchiveWorkspaceInput,
): Promise<WorkspaceDetail> {
  const detail = await getWorkspace(db, id);
  if (!detail) throw new Error("workspace not found");

  await db
    .update(workspaces)
    .set({
      status: "archiving",
      summary: input.summary ?? detail.summary,
      mergedPrUrl: input.mergedPrUrl ?? detail.mergedPrUrl ?? linkedPrUrl(detail),
      // Cleared so `archiving` with no error means "teardown still running" —
      // a retry after a dirty-worktree refusal must not read as still failed.
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, id));

  return detail;
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
  const inFlight = archivals.get(id);
  if (inFlight) return inFlight;
  return trackArchive(db, await beginArchive(db, id, input), input, runner);
}

/**
 * Kicks off the teardown and returns as soon as the workspace reads
 * `archiving`, so the caller isn't held for the length of a worktree removal.
 * The outcome lands on the workspace row (status `archived`, or `archiving`
 * with the per-repo error on a dirty worktree), which callers poll for.
 */
export async function startArchiveWorkspace(
  db: Db,
  id: string,
  input: ArchiveWorkspaceInput = {},
  runner: GitRunner = defaultGitRunner,
): Promise<ArchiveResult> {
  if (!archivals.has(id)) {
    const detail = await beginArchive(db, id, input);
    void trackArchive(db, detail, input, runner).catch(async (e) => {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[workspaces] background archive failed:", e);
      await db
        .update(workspaces)
        .set({ error: message, updatedAt: new Date() })
        .where(eq(workspaces.id, id))
        .catch(() => {});
      // Nothing is waiting on this promise, so the attention flag is the only
      // way an unexpected failure reaches the user.
      await raiseArchiveFailure(db, detail, [{ repo: "workspace", message }]);
    });
  }
  return { status: "archiving", errors: [], completedTasks: 0 };
}

function trackArchive(
  db: Db,
  detail: WorkspaceDetail,
  input: ArchiveWorkspaceInput,
  runner: GitRunner,
): Promise<ArchiveResult> {
  const run = removeWorktreesAndFinish(db, detail, input, runner).finally(() =>
    archivals.delete(detail.id),
  );
  archivals.set(detail.id, run);
  return run;
}

async function removeWorktreesAndFinish(
  db: Db,
  detail: WorkspaceDetail,
  input: ArchiveWorkspaceInput,
  runner: GitRunner,
): Promise<ArchiveResult> {
  const id = detail.id;

  // Stop any remote-control Claude session first so it isn't holding the
  // worktree while we remove it. Best-effort: the core may be unreachable.
  try {
    await stopClaudeSession(id);
  } catch (e) {
    console.warn("[workspaces] failed to stop Claude session on archive:", e);
  }

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
      // A torn-down workspace has no session left to hand a kick-off to, so a
      // prompt still pending on it is only a copy of the ticket body kept alive
      // for nobody.
      pendingIssuePrompt: fullyRemoved ? null : detail.pendingIssuePrompt,
      archivedAt: fullyRemoved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, id));

  // Completing the work means the linked task is done — but only once the
  // workspace is fully torn down, so a partial archive stays reopenable.
  const completedTasks = fullyRemoved ? await completeTasksByWorkspace(db, id) : [];

  if (fullyRemoved) {
    // An archived workspace can't want anything: drop whatever it was still
    // flagging, including the failure a previous attempt raised.
    for (const item of await clearAttentionScope(db, { workspaceId: id }, "resolved")) {
      publish(item);
    }
  } else {
    await raiseArchiveFailure(db, detail, errors);
  }

  return { status, errors, completedTasks: completedTasks.length };
}
