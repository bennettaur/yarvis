import { ensureOk, sidecarFetch } from "../api";
import { prRefQuery } from "./guide";
import type { PrRef } from "./types";

/**
 * Client for line insights: answers to questions the reviewer asked about
 * specific code, kept beside that code and local until posted.
 */

export interface PrInsight {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  /** Commit the answer was written against. */
  headSha: string;
  question: string;
  answer: string;
  /** Set once the insight has been shared with the pull request's author. */
  postedAt: string | null;
  createdAt: string;
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  await ensureOk(res, path);
  return res.json();
}

export async function fetchPrInsights(ref: PrRef): Promise<PrInsight[]> {
  const res = await request<{ insights: PrInsight[] }>(
    `/api/pr/insights?${prRefQuery(ref)}`,
    "GET",
  );
  return res.insights;
}

export interface AskAboutLinesInput {
  path: string;
  startLine: number;
  endLine: number;
  /** The selected lines as rendered, so the agent sees what the reader sees. */
  selection: string;
  question: string;
}

/**
 * Asks about a selection and stores the answer. An agent run, so it is slow —
 * callers need to show that something is happening.
 */
export function askAboutLines(ref: PrRef, input: AskAboutLinesInput): Promise<PrInsight> {
  return request<PrInsight>("/api/pr/insight", "POST", { ref, ...input });
}

/** Shares an insight with the pull request's author as a line comment. */
export function postInsight(id: string): Promise<PrInsight> {
  return request<PrInsight>(`/api/pr/insight/${encodeURIComponent(id)}/post`, "POST");
}

export function deletePrInsight(id: string): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/pr/insight/${encodeURIComponent(id)}`, "DELETE");
}
