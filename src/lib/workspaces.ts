import { sidecarFetch, streamSSE } from "./api";
import type { Repo } from "./repos";

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
}

export interface CreateWorkspaceInput {
  name: string;
  repoIds: string[];
  taskId?: string | null;
}

export interface ArchiveWorkspaceInput {
  summary?: string | null;
  mergedPrUrl?: string | null;
  force?: boolean;
}

export interface ArchiveResult {
  status: WorkspaceStatus;
  errors: { repo: string; message: string }[];
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

export async function listWorkspaces(): Promise<Workspace[]> {
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
 * Drives provisioning of a workspace's worktrees, yielding progress events as
 * they stream in (setup-script output arrives as `log` events).
 */
export async function* provisionWorkspace(id: string): AsyncGenerator<ProvisionEvent> {
  for await (const data of streamSSE(`/api/workspaces/${id}/provision`, { method: "POST" })) {
    yield JSON.parse(data) as ProvisionEvent;
  }
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
