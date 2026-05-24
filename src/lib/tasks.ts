import { sidecarFetch } from "./api";

export interface Task {
  id: string;
  title: string;
  status: "open" | "done";
  scope: "daily" | "weekly";
  targetDate: string | null;
  notes: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TaskFilter {
  status?: "open" | "done";
  scope?: "daily" | "weekly";
  targetDate?: string;
}

export interface CreateTaskInput {
  title: string;
  scope: "daily" | "weekly";
  targetDate?: string | null;
  notes?: string | null;
}

export async function listTasks(filter: TaskFilter = {}): Promise<Task[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.scope) params.set("scope", filter.scope);
  if (filter.targetDate) params.set("targetDate", filter.targetDate);
  const qs = params.toString();
  const res = await sidecarFetch(`/api/tasks${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error(`list tasks failed: ${res.status}`);
  return res.json();
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await sidecarFetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create task failed: ${res.status}`);
  return res.json();
}

export async function completeTask(id: string): Promise<Task> {
  const res = await sidecarFetch(`/api/tasks/${id}/complete`, { method: "POST" });
  if (!res.ok) throw new Error(`complete task failed: ${res.status}`);
  return res.json();
}

export async function updateTask(
  id: string,
  patch: Partial<Omit<Task, "id" | "createdAt" | "completedAt" | "sourceSessionId">>,
): Promise<Task> {
  const res = await sidecarFetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update task failed: ${res.status}`);
  return res.json();
}

export async function rolloverTasks(
  fromDate: string,
  toDate: string,
): Promise<{ moved: number; tasks: Task[] }> {
  const res = await sidecarFetch("/api/tasks/rollover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromDate, toDate }),
  });
  if (!res.ok) throw new Error(`rollover failed: ${res.status}`);
  return res.json();
}
