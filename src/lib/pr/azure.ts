import { sidecarFetch } from "../api";
import { refApiPath } from "./ref";
import type {
  AzFilter,
  NewComment,
  PrDetail,
  PrFile,
  PrRef,
  PrStatus,
  PrSummary,
  StarredPr,
} from "./types";

/** Azure-native PR summary as the sidecar routes return it. */
interface AzRawSummary {
  prId: number;
  title: string;
  url: string;
  org: string;
  project: string;
  repo: string;
  author: string;
  draft: boolean;
  status: string;
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

function toSummary(raw: AzRawSummary): PrSummary {
  return {
    ref: { provider: "azure", org: raw.org, project: raw.project, repo: raw.repo, prId: raw.prId },
    title: raw.title,
    url: raw.url,
    author: raw.author,
    draft: raw.draft,
    state: raw.status,
    createdAt: raw.createdAt,
    updatedAt: raw.createdAt,
  };
}

/** Narrows a ref to its Azure variant (callers only pass Azure refs here). */
function az(ref: PrRef): Extract<PrRef, { provider: "azure" }> {
  if (ref.provider !== "azure") throw new Error("expected an azure ref");
  return ref;
}

export const azViewer = () => get<{ login: string; id?: string }>("/api/azure/viewer");

export async function azSearch(scope: "mine" | "review", project?: string): Promise<PrSummary[]> {
  const query = new URLSearchParams({ scope });
  if (project) query.set("project", project);
  const raw = await get<AzRawSummary[]>(`/api/azure/search?${query.toString()}`);
  return raw.map(toSummary);
}

export const azPrStatus = (ref: PrRef) => get<PrStatus>(refApiPath(ref));
export const azPrDetail = (ref: PrRef) => get<PrDetail>(`${refApiPath(ref)}/detail`);
export const azPrFiles = (ref: PrRef) => get<PrFile[]>(`${refApiPath(ref)}/files`);
export const azPrFileDiff = (ref: PrRef, path: string) =>
  get<PrFile>(`${refApiPath(ref)}/file?path=${encodeURIComponent(path)}`);
export const azPostComment = (ref: PrRef, comment: NewComment) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/comments`, "POST", comment);

export const azFilters = () => get<AzFilter[]>("/api/azure/filters");
export const azCreateFilter = (name: string, scope: "mine" | "review", project: string | null) =>
  send<AzFilter>("/api/azure/filters", "POST", { name, scope, project });
export const azDeleteFilter = (id: string) =>
  send<{ deleted: boolean }>(`/api/azure/filters/${id}`, "DELETE");

interface AzRawStar {
  org: string;
  project: string;
  repo: string;
  prId: number;
  title: string | null;
  url: string | null;
}

export async function azStars(): Promise<StarredPr[]> {
  const raw = await get<AzRawStar[]>("/api/azure/stars");
  return raw.map((s) => ({
    ref: { provider: "azure", org: s.org, project: s.project, repo: s.repo, prId: s.prId },
    title: s.title,
    url: s.url,
  }));
}

export function azAddStar(ref: PrRef, title?: string | null, url?: string | null) {
  const r = az(ref);
  return send<{ ok: boolean }>("/api/azure/stars", "POST", {
    org: r.org,
    project: r.project,
    repo: r.repo,
    prId: r.prId,
    title,
    url,
  });
}

export function azRemoveStar(ref: PrRef) {
  const r = az(ref);
  return send<{ deleted: boolean }>(
    `/api/azure/stars/${r.org}/${r.project}/${r.repo}/${r.prId}`,
    "DELETE",
  );
}
