import { sidecarFetch } from "./api";

export interface PrSummary {
  number: number;
  title: string;
  url: string;
  owner: string;
  repo: string;
  author: string;
  draft: boolean;
  state: string;
  updatedAt: string;
}

export interface PrStatus {
  mergeable: boolean | null;
  mergeableState: string;
  checks: { total: number; success: number; failure: number; pending: number };
}

export interface GhFilter {
  id: string;
  name: string;
  query: string;
  createdAt: string;
}

export interface GhStar {
  id: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  url: string | null;
  createdAt: string;
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

export const ghViewer = () => get<{ login: string }>("/api/github/viewer");
export const ghSearch = (q: string) =>
  get<PrSummary[]>(`/api/github/search?q=${encodeURIComponent(q)}`);
export const ghPrStatus = (owner: string, repo: string, number: number) =>
  get<PrStatus>(`/api/github/pr/${owner}/${repo}/${number}`);

export const ghFilters = () => get<GhFilter[]>("/api/github/filters");
export const ghCreateFilter = (name: string, query: string) =>
  send<GhFilter>("/api/github/filters", "POST", { name, query });
export const ghDeleteFilter = (id: string) =>
  send<{ deleted: boolean }>(`/api/github/filters/${id}`, "DELETE");

export const ghStars = () => get<GhStar[]>("/api/github/stars");
export const ghAddStar = (pr: {
  owner: string;
  repo: string;
  number: number;
  title?: string | null;
  url?: string | null;
}) => send<{ ok: boolean }>("/api/github/stars", "POST", pr);
export const ghRemoveStar = (owner: string, repo: string, number: number) =>
  send<{ deleted: boolean }>(
    `/api/github/stars/${owner}/${repo}/${number}`,
    "DELETE",
  );
