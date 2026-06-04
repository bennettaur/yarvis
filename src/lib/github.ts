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
  createdAt: string;
  updatedAt: string;
}

export interface PrStatus {
  mergeable: boolean | null;
  mergeableState: string;
  checks: { total: number; success: number; failure: number; pending: number };
}

export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewThread {
  path: string | null;
  line: number | null;
  isResolved: boolean;
  comments: ReviewComment[];
}

export interface CheckItem {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export interface PrDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  mergeable: string;
  checks: CheckItem[];
  reviewThreads: ReviewThread[];
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
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

// Owner/repo segments can originate from agent-composed Omni layouts, so encode
// them rather than interpolating untrusted text straight into the request path.
const prPath = (owner: string, repo: string, number: number) =>
  `/api/github/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`;

export const ghViewer = () => get<{ login: string }>("/api/github/viewer");
export const ghSearch = (q: string) =>
  get<PrSummary[]>(`/api/github/search?q=${encodeURIComponent(q)}`);
export const ghPrStatus = (owner: string, repo: string, number: number) =>
  get<PrStatus>(prPath(owner, repo, number));
export const ghPrDetail = (owner: string, repo: string, number: number) =>
  get<PrDetail>(`${prPath(owner, repo, number)}/detail`);
export const ghPrFiles = (owner: string, repo: string, number: number) =>
  get<PrFile[]>(`${prPath(owner, repo, number)}/files`);

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
  send<{ deleted: boolean }>(`/api/github/stars/${owner}/${repo}/${number}`, "DELETE");
