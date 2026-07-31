import { ensureOk, sidecarFetch } from "../api";
import { refApiPath } from "./ref";
import type {
  GhFilter,
  GhPrConfig,
  MergeMethod,
  NewComment,
  PrDetail,
  PrFile,
  PrRef,
  PrStatus,
  PrSummary,
  ReviewingList,
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
  await ensureOk(res, path);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  await ensureOk(res, path);
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

/**
 * The list-row summary for one PR, used to open a PR the user named by link or
 * by repo + number instead of picking it out of a list.
 */
export async function ghPrSummary(ref: PrRef): Promise<PrSummary> {
  return toSummary(await get<GhRawSummary>(`${refApiPath(ref)}/summary`));
}

/** PRs the user is part-way through reviewing, split into outstanding and done. */
export const ghReviewing = () => get<ReviewingList>("/api/github/reviewing");

export const ghPrConfig = () => get<GhPrConfig>("/api/github/config");
export const ghSavePrConfig = (config: GhPrConfig) =>
  send<GhPrConfig>("/api/github/config", "PUT", config);

export const ghPrStatus = (ref: PrRef) => get<PrStatus>(refApiPath(ref));
export const ghPrDetail = (ref: PrRef) => get<PrDetail>(`${refApiPath(ref)}/detail`);
export const ghPrFiles = (ref: PrRef) => get<PrFile[]>(`${refApiPath(ref)}/files`);
export const ghPostComment = (ref: PrRef, comment: NewComment) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/comments`, "POST", comment);

export const ghMarkReady = (ref: PrRef) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/ready`, "POST");

export const ghSubmitReview = (
  ref: PrRef,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body?: string,
) => send<{ ok: boolean }>(`${refApiPath(ref)}/reviews`, "POST", { event, body });

export const ghMergePr = (ref: PrRef, method: MergeMethod) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/merge`, "POST", { method });

export const ghEnableAutoMerge = (ref: PrRef, method: MergeMethod) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/auto-merge`, "POST", { method });

export const ghDisableAutoMerge = (ref: PrRef) =>
  send<{ ok: boolean }>(`${refApiPath(ref)}/auto-merge`, "DELETE");

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
