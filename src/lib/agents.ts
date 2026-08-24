import { sidecarFetch } from "./api";

/**
 * Client for the specialists the assistant delegates to, and the background jobs
 * that write memory. Both are configuration surfaces: what a specialist is
 * allowed to do, and whether the consolidation passes are actually running.
 */

export interface Specialist {
  id: string;
  name: string;
  description: string;
  prompt: string;
  toolIds: string[];
  /** Tools it may use without the user approving each call. */
  unattendedToolIds: string[];
  provider: string | null;
  model: string | null;
  maxSteps: number;
  builtin: boolean;
  enabled: boolean;
}

export interface JobStatus {
  name: string;
  description: string;
  schedule: { kind: "interval"; everyMs: number } | { kind: "daily"; hour: number };
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  running: boolean;
  due: boolean;
}

export interface JobRunResult {
  ran: boolean;
  status: "ok" | "error" | "skipped" | "busy";
  detail?: string;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `${method} ${path} → ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  return res.json();
}

export const listSpecialists = () => request<Specialist[]>("/api/specialists");

export const updateSpecialist = (
  id: string,
  patch: { prompt?: string; enabled?: boolean; provider?: string | null; model?: string | null },
) => request<Specialist>(`/api/specialists/${id}`, "PATCH", patch);

export const resetSpecialist = (name: string) =>
  request<Specialist>(`/api/specialists/${name}/reset`, "POST", {});

export const listJobs = () => request<{ jobs: JobStatus[] }>("/api/jobs").then((body) => body.jobs);

/**
 * Triggers a job. A 409 is the lease refusing a second copy of a run already in
 * flight — an outcome to report, not an error, so it is read from the body
 * rather than thrown.
 */
export async function runJob(name: string): Promise<JobRunResult> {
  const res = await sidecarFetch(`/api/jobs/${name}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (res.status === 409) return (await res.json()) as JobRunResult;
  if (!res.ok) throw new Error(`POST /api/jobs/${name}/run → ${res.status}`);
  return res.json();
}

export interface JobConfig {
  ccDigestEnabled: boolean;
  ccDigestProjectDirs: string[];
}

export interface JobConfigResult {
  config: JobConfig;
  /** Claude Code project directories on this machine, to choose from. */
  availableProjectDirs: { dir: string; path: string | null }[];
}

export const getJobConfig = () => request<JobConfigResult>("/api/jobs/config");

export const saveJobConfig = (config: JobConfig) =>
  request<{ config: JobConfig }>("/api/jobs/config", "PUT", config).then((b) => b.config);
