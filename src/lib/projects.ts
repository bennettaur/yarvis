import { sidecarFetch } from "./api";
import type { Priority } from "./todos";

/** Client for the projects the assistant tracks work against. */

export type ProjectStatus = "active" | "paused" | "shipped" | "abandoned";

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  summary: string | null;
  focus: string | null;
  repoIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectItem {
  id: string;
  projectId: string;
  kind: "jira" | "github" | "pr" | "note";
  externalKey: string | null;
  title: string;
  priority: Priority;
  note: string | null;
  doneAt: string | null;
}

export interface ProjectTask {
  id: string;
  title: string;
  scope: string;
  targetDate: string | null;
}

export interface ProjectOverview {
  project: Project;
  items: ProjectItem[];
  openTasks: ProjectTask[];
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return res.json();
}

export const listProjects = () => request<Project[]>("/api/projects");

export const getProject = (id: string) => request<ProjectOverview>(`/api/projects/${id}`);

export const updateProject = (
  id: string,
  patch: { status?: ProjectStatus; focus?: string; summary?: string },
) => request<Project>(`/api/projects/${id}`, "PATCH", patch);

export const updateProjectItem = (
  itemId: string,
  patch: { priority?: Priority; done?: boolean; note?: string },
) => request<ProjectItem>(`/api/projects/items/${itemId}`, "PATCH", patch);
