import { sidecarFetch } from "./api";

/** A repo yarvis manages a primary clone + worktrees for. */
export interface Repo {
  id: string;
  name: string;
  owner: string;
  repo: string;
  cloneUrl: string;
  defaultBranch: string | null;
  primaryClonePath: string;
  setupScript: string | null;
  runScript: string | null;
  pullIssues: boolean;
  createdAt: string;
  updatedAt: string;
}

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

async function readError(res: Response, action: string): Promise<never> {
  const body = await res.json().catch(() => null);
  const detail = body && typeof body === "object" && "error" in body ? body.error : res.status;
  throw new Error(
    `${action} failed: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
  );
}

export async function listRepos(): Promise<Repo[]> {
  const res = await sidecarFetch("/api/repos");
  if (!res.ok) return readError(res, "list repos");
  return res.json();
}

export async function createRepo(input: CreateRepoInput): Promise<Repo> {
  const res = await sidecarFetch("/api/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return readError(res, "create repo");
  return res.json();
}

export async function updateRepo(id: string, patch: UpdateRepoInput): Promise<Repo> {
  const res = await sidecarFetch(`/api/repos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return readError(res, "update repo");
  return res.json();
}

export async function deleteRepo(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/repos/${id}`, { method: "DELETE" });
  if (!res.ok) return readError(res, "delete repo");
}
