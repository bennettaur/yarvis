import { sidecarFetch } from "./api";

/**
 * Client for the specialists the assistant delegates to, and the background jobs
 * that write memory. Both are configuration surfaces: what a specialist is
 * allowed to do, and whether the consolidation passes are actually running.
 */

/** A specialist as loaded from its markdown definition. */
export interface Specialist {
  name: string;
  description: string;
  prompt: string;
  /** Bare built-in tool names, as the file lists them. */
  tools: string[];
  /** Tools it may use without the user approving each call. */
  unattended: string[];
  provider: string | null;
  model: string | null;
  maxSteps: number;
  enabled: boolean;
  /** "builtin" ships with the app; "user" comes from the agents directory. */
  source: "builtin" | "user";
  path: string;
}

/** A definition file that failed to parse, reported rather than skipped. */
export interface SpecialistProblem {
  path: string;
  message: string;
}

export interface SpecialistCatalog {
  specialists: Specialist[];
  problems: SpecialistProblem[];
  /** Directory user definitions are read from. */
  userDir: string;
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

export const listSpecialists = () => request<SpecialistCatalog>("/api/specialists");

/** Re-reads the definition files, for after an edit. */
export const reloadSpecialists = () =>
  request<SpecialistCatalog>("/api/specialists/reload", "POST", {});

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
