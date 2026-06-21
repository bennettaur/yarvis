import { sidecarFetch } from "../api";
import { refApiPath } from "./ref";
import type {
  GhFilter,
  NewComment,
  PrDetail,
  PrFile,
  PrRef,
  PrStatus,
  PrSummary,
  StarredPr,
} from "./types";

/** Flat PR summary as the GitHub sidecar routes return it (identity inline). */
interface GhRawSummary {
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

function toSummary(raw: GhRawSummary): PrSummary {
  return {
    ref: { provider: "github", owner: raw.owner, repo: raw.repo, number: raw.number },
    title: raw.title,
    url: raw.url,
    author: raw.author,
    draft: raw.draft,
    state: raw.state,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** Narrows a ref to its GitHub variant (callers only pass GitHub refs here). */
function gh(ref: PrRef): Extract<PrRef, { provider: "github" }> {
  if (ref.provider !== "github") throw new Error("expected a github ref");
  return ref;
}

export const ghViewer = () => get<{ login: string }>("/api/github/viewer");

export async function ghSearch(query: string): Promise<PrSummary[]> {
  const raw = await get<GhRawSummary[]>(`/api/github/search?q=${encodeURIComponent(query)}`);
  return raw.map(toSummary);
}

export const ghPrStatus = (ref: PrRef) => get<PrStatus>(refApiPath(ref));
export const ghPrDetail = (ref: PrRef) => get<PrDetail>(`${refApiPath(ref)}/detail`);
export const ghPrFiles = (ref: PrRef) => get<PrFile[]>(`${refApiPath(ref)}/files`);
export const ghPostComment = (ref: PrRef, comment: NewComment) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/comments`, "POST", comment);

export const ghFilters = () => get<GhFilter[]>("/api/github/filters");
export const ghCreateFilter = (name: string, query: string) =>
  send<GhFilter>("/api/github/filters", "POST", { name, query });
export const ghDeleteFilter = (id: string) =>
  send<{ deleted: boolean }>(`/api/github/filters/${id}`, "DELETE");

interface GhRawStar {
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  url: string | null;
}

export async function ghStars(): Promise<StarredPr[]> {
  const raw = await get<GhRawStar[]>("/api/github/stars");
  return raw.map((s) => ({
    ref: { provider: "github", owner: s.owner, repo: s.repo, number: s.number },
    title: s.title,
    url: s.url,
  }));
}

export function ghAddStar(ref: PrRef, title?: string | null, url?: string | null) {
  const r = gh(ref);
  return send<{ ok: boolean }>("/api/github/stars", "POST", {
    owner: r.owner,
    repo: r.repo,
    number: r.number,
    title,
    url,
  });
}

export function ghRemoveStar(ref: PrRef) {
  const r = gh(ref);
  return send<{ deleted: boolean }>(`/api/github/stars/${r.owner}/${r.repo}/${r.number}`, "DELETE");
}
