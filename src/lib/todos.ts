import { sidecarFetch } from "./api";

/**
 * Client for the assistant's own todo list. Read-write from the UI so the user
 * can see what it thinks it is doing — and correct it — while the agent drives
 * the same rows through its tools.
 */

export type TodoStatus = "pending" | "in_progress" | "blocked" | "done" | "wont_do";
export type Priority = "urgent" | "high" | "medium" | "low";

export interface TodoNote {
  at: string;
  text: string;
}

export interface AgentTodo {
  id: string;
  title: string;
  details: string | null;
  status: TodoStatus;
  priority: Priority;
  projectId: string | null;
  dueAt: string | null;
  notes: TodoNote[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
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

export const listTodos = (statuses?: TodoStatus[]) => {
  const params = new URLSearchParams();
  for (const status of statuses ?? []) params.append("status", status);
  const query = params.toString();
  return request<AgentTodo[]>(`/api/todos${query ? `?${query}` : ""}`);
};

export const updateTodo = (
  id: string,
  patch: { status?: TodoStatus; priority?: Priority; note?: string },
) => request<AgentTodo>(`/api/todos/${id}`, "PATCH", patch);

export const deleteTodo = (id: string) =>
  request<{ deleted: boolean }>(`/api/todos/${id}`, "DELETE");
