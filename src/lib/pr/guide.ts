import { ensureOk, sidecarFetch } from "../api";
import type { PrRef } from "./types";

/**
 * Client for the generated review guide. Unlike the rest of this directory
 * there is no per-provider transport: the guide routes take the ref in the
 * request rather than the path, so one set of calls serves both providers.
 */

/** One stop on the tour: what to look at, and why it comes here. */
export interface PrGuideStep {
  path: string;
  startLine: number | null;
  endLine: number | null;
  explanation: string;
  /** Longer background, shown only when the reader expands the step. */
  context?: string;
}

export interface PrGuide {
  /** Commit the guide was generated against. */
  headSha: string;
  steps: PrGuideStep[];
  currentStep: number;
  /** True once the pull request has moved past `headSha`. */
  stale: boolean;
  createdAt: string;
}

/**
 * Serializes a ref into query parameters, matching what the sidecar's GET and
 * DELETE handlers reassemble. Those two can't carry a body, so the ref travels
 * in the URL for them and in the body everywhere else.
 */
function refQuery(ref: PrRef): string {
  const params: Record<string, string> =
    ref.provider === "github"
      ? {
          provider: "github",
          owner: ref.owner,
          repo: ref.repo,
          number: String(ref.number),
        }
      : {
          provider: "azure",
          org: ref.org,
          project: ref.project,
          repo: ref.repo,
          prId: String(ref.prId),
        };
  return new URLSearchParams(params).toString();
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

export async function fetchPrGuide(ref: PrRef): Promise<PrGuide | null> {
  const res = await request<{ guide: PrGuide | null }>(`/api/pr/guide?${refQuery(ref)}`, "GET");
  return res.guide;
}

/**
 * Runs the exploration and stores the result, replacing any existing guide.
 * This is an agent run over the pull request, so it is slow by nature — callers
 * need to show that something is happening rather than assuming a quick reply.
 */
export function generatePrGuide(
  ref: PrRef,
  title?: string | null,
  url?: string | null,
): Promise<PrGuide> {
  return request<PrGuide>("/api/pr/guide", "POST", { ref, title, url });
}

export function setPrGuideProgress(ref: PrRef, step: number): Promise<{ currentStep: number }> {
  return request<{ currentStep: number }>("/api/pr/guide/progress", "PATCH", { ref, step });
}

export function deletePrGuide(ref: PrRef): Promise<{ deleted: boolean }> {
  return request<{ deleted: boolean }>(`/api/pr/guide?${refQuery(ref)}`, "DELETE");
}
