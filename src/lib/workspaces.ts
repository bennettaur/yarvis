import { sidecarFetch, streamSSE } from "./api";
import type { IssueLink } from "./issues/types";
import type { PrRef } from "./pr/types";
import type { Repo } from "./repos";
import type { Task } from "./tasks";

export type WorkspaceStatus = "creating" | "active" | "archiving" | "archived" | "error";
export type WorkspaceRepoStatus = "pending" | "provisioning" | "ready" | "removed" | "error";
export type CheckRollup = "success" | "failure" | "pending" | "none";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  rootPath: string;
  summary: string | null;
  mergedPrUrl: string | null;
  error: string | null;
  /**
   * The "Start work" prompt this workspace was kicked off with, held by the
   * sidecar until the agent session has been handed it. Non-null means the
   * kick-off is unfinished: provisioning writes the prompt to
   * `.yarvis/issue-prompt.md`, and the workspace view launches the agent against
   * it. Surviving in the database is what lets an interrupted kick-off resume.
   */
  pendingIssuePrompt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** Poller cache of the PR + checks for a workspace repo (populated in PR3). */
export interface WorkspaceRepoPr {
  prNumber: number | null;
  prUrl: string | null;
  prState: string | null;
  isDraft: boolean | null;
  mergeable: string | null;
  checkRollup: CheckRollup;
  checks: { total: number; success: number; failure: number; pending: number } | null;
  lastPolledAt: string | null;
  lastError: string | null;
}

export interface WorkspaceRepoDetail {
  id: string;
  workspaceId: string;
  repoId: string;
  status: WorkspaceRepoStatus;
  branch: string;
  /** Whether `branch` is a pre-existing branch rather than a fresh one. */
  existingBranch: boolean;
  baseBranch: string;
  worktreePath: string;
  setupLog: string | null;
  setupExitCode: number | null;
  error: string | null;
  createdAt: string;
  repo: Repo;
  pr: WorkspaceRepoPr | null;
}

export interface WorkspaceDetail extends Workspace {
  repos: WorkspaceRepoDetail[];
  tasks: Task[];
  /** GitHub/JIRA issues linked to this workspace. */
  issues: IssueLink[];
}

/** A workspace list row, with its repo names for sidebar grouping. The pending
 *  kick-off prompt is not part of it — only the open workspace needs that, and
 *  this list is polled for every workspace at once. */
export interface WorkspaceSummary extends Omit<Workspace, "pendingIssuePrompt"> {
  repoNames: string[];
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** Push/pull divergence of a workspace repo's branch (from `/sync`). */
export interface WorkspaceRepoSync {
  /** Local commits not yet on the remote branch — changes to push. */
  ahead: number;
  /** Remote-branch commits missing locally — changes to pull. 0 until pushed. */
  behind: number;
  /** Commits the base branch has moved on by since this branch — pull/rebase. */
  baseBehind: number;
  /** Whether the branch has been pushed (a remote-tracking branch exists). */
  hasRemote: boolean;
  /** Set when the pre-count fetch failed; counts are then last-known. */
  fetchError: string | null;
}

/** An active workspace a PR was raised from, for the PR-view backlink. */
export interface WorkspaceForPr {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
}

export interface CreateWorkspaceInput {
  name: string;
  /** Empty for a scratch workspace: just a folder to run Claude in. */
  repoIds: string[];
  /**
   * Per-repo (keyed by repo id) existing branch to check out instead of cutting
   * a fresh branch. Omit a repo, or map it to "", for the default new-branch flow.
   */
  existingBranches?: Record<string, string>;
  taskId?: string | null;
  /**
   * A "Start work" prompt to seed the workspace's agent session with. The
   * sidecar holds it on the workspace row, so the launch survives this view
   * being unmounted mid-provision.
   */
  issuePrompt?: string;
}

export interface ArchiveWorkspaceInput {
  summary?: string | null;
  mergedPrUrl?: string | null;
  force?: boolean;
}

export interface ArchiveResult {
  status: WorkspaceStatus;
  errors: { repo: string; message: string }[];
  completedTasks: number;
}

/** A progress event emitted while a workspace's worktrees are provisioned. */
export type ProvisionEvent =
  | { type: "repo-start"; workspaceRepoId: string; repo: string }
  | { type: "log"; workspaceRepoId: string; text: string }
  | { type: "repo-done"; workspaceRepoId: string; status: string; exitCode?: number }
  | { type: "repo-error"; workspaceRepoId: string; message: string }
  | { type: "done"; status: string }
  | { type: "error"; message: string };

async function readError(res: Response, action: string): Promise<never> {
  const body = await res.json().catch(() => null);
  const detail = body && typeof body === "object" && "error" in body ? body.error : res.status;
  throw new Error(
    `${action} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
  );
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const res = await sidecarFetch("/api/workspaces");
  if (!res.ok) return readError(res, "list workspaces");
  return res.json();
}

export async function getWorkspace(id: string): Promise<WorkspaceDetail> {
  const res = await sidecarFetch(`/api/workspaces/${id}`);
  if (!res.ok) return readError(res, "get workspace");
  return res.json();
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const res = await sidecarFetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return readError(res, "create workspace");
  return res.json();
}

/**
 * Drops the workspace's pending "Start work" prompt, once its agent session is
 * live and has been handed the ticket.
 */
export async function clearPendingIssuePrompt(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/workspaces/${id}/issue-prompt`, { method: "DELETE" });
  if (!res.ok) return readError(res, "clear pending issue prompt");
}

/**
 * Drives provisioning of a workspace's worktrees, yielding progress events as
 * they stream in (setup-script output arrives as `log` events). A workspace
 * already being provisioned streams the run in flight rather than failing, so
 * reopening a workspace mid-provision picks its log back up.
 */
export async function* provisionWorkspace(id: string): AsyncGenerator<ProvisionEvent> {
  for await (const data of streamSSE(`/api/workspaces/${id}/provision`, { method: "POST" })) {
    yield JSON.parse(data) as ProvisionEvent;
  }
}

export async function workspaceRepoFiles(
  workspaceId: string,
  workspaceRepoId: string,
): Promise<string[]> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/repos/${workspaceRepoId}/files`);
  if (!res.ok) return readError(res, "list files");
  return res.json();
}

export async function workspaceRepoChanges(
  workspaceId: string,
  workspaceRepoId: string,
): Promise<ChangedFile[]> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/repos/${workspaceRepoId}/changes`);
  if (!res.ok) return readError(res, "list changes");
  return res.json();
}

export interface FileDiff {
  path: string;
  /** Unified-diff patch; empty when the file has no textual diff (binary/unchanged). */
  patch: string;
}

/** Unified diff for a single changed file in a workspace repo's worktree. */
export async function workspaceRepoFileDiff(
  workspaceId: string,
  workspaceRepoId: string,
  path: string,
): Promise<FileDiff> {
  const res = await sidecarFetch(
    `/api/workspaces/${workspaceId}/repos/${workspaceRepoId}/diff?path=${encodeURIComponent(path)}`,
  );
  if (!res.ok) return readError(res, "load file diff");
  return res.json();
}

/** Push/pull divergence for a workspace repo's branch (fetches remote first). */
export async function workspaceRepoSync(
  workspaceId: string,
  workspaceRepoId: string,
): Promise<WorkspaceRepoSync> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/repos/${workspaceRepoId}/sync`);
  if (!res.ok) return readError(res, "load sync status");
  return res.json();
}

/**
 * The active workspace a PR was raised from, or null. The provider-tagged ref
 * selects which identity the poller cache is matched on (GitHub owner/repo vs
 * Azure org/project/repo).
 */
export async function findWorkspaceForPr(ref: PrRef): Promise<WorkspaceForPr | null> {
  const query =
    ref.provider === "azure"
      ? new URLSearchParams({
          provider: "azure",
          org: ref.org,
          project: ref.project,
          repo: ref.repo,
          number: String(ref.prId),
        })
      : new URLSearchParams({
          provider: "github",
          owner: ref.owner,
          repo: ref.repo,
          number: String(ref.number),
        });
  const res = await sidecarFetch(`/api/workspaces/for-pr?${query}`);
  if (!res.ok) return readError(res, "find workspace for PR");
  return res.json();
}

export async function linkWorkspaceTask(workspaceId: string, taskId: string): Promise<void> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });
  if (!res.ok) return readError(res, "link task");
}

export async function unlinkWorkspaceTask(workspaceId: string, taskId: string): Promise<void> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/tasks/${taskId}`, {
    method: "DELETE",
  });
  if (!res.ok) return readError(res, "unlink task");
}

/** A GitHub or JIRA issue to attach to a workspace, keyed by the source-agnostic
 *  triple (provider, sourceKey, externalId). */
export interface LinkIssueInput {
  provider: "github" | "jira";
  sourceKey: string;
  externalId: string;
  title?: string | null;
  url?: string | null;
}

export async function linkWorkspaceIssue(
  workspaceId: string,
  input: LinkIssueInput,
): Promise<IssueLink> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return readError(res, "link issue");
  return res.json();
}

export async function unlinkWorkspaceIssue(
  workspaceId: string,
  issue: { provider: string; sourceKey: string; externalId: string },
): Promise<void> {
  const query = new URLSearchParams({
    provider: issue.provider,
    sourceKey: issue.sourceKey,
    externalId: issue.externalId,
  });
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/issues?${query}`, {
    method: "DELETE",
  });
  if (!res.ok) return readError(res, "unlink issue");
}

export async function archiveWorkspace(
  id: string,
  input: ArchiveWorkspaceInput = {},
): Promise<ArchiveResult> {
  const res = await sidecarFetch(`/api/workspaces/${id}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return readError(res, "archive workspace");
  return res.json();
}
