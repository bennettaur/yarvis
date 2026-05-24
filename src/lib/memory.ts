import type { ProviderId } from "./chat";
import { sidecarFetch } from "./api";

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  score?: number;
}

export interface RecapTask {
  id: string;
  title: string;
  scope: string;
  notes: string | null;
}

export interface RecapResult {
  label: string;
  recap: string;
  tasks: RecapTask[];
  notes: MemoryRecord[];
}

export interface IngestResult {
  source: string;
  chunks: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const memList = (type?: string) =>
  get<MemoryRecord[]>(`/api/memory${type ? `?type=${encodeURIComponent(type)}` : ""}`);

export const memSearch = (q: string) =>
  get<MemoryRecord[]>(`/api/memory/search?q=${encodeURIComponent(q)}`);

export const memAddNote = (content: string) =>
  send<MemoryRecord>("/api/memory/notes", "POST", { content });

export const memDelete = (id: string) =>
  send<{ deleted: boolean }>(`/api/memory/${id}`, "DELETE");

export const memIngest = (input: { url?: string; text?: string; title?: string }) =>
  send<IngestResult>("/api/memory/ingest", "POST", input);

export const memRecap = (
  range: "day" | "week",
  provider?: ProviderId,
  model?: string,
) => send<RecapResult>("/api/memory/recap", "POST", { range, provider, model });
