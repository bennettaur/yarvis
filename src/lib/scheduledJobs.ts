import { sidecarFetch } from "./api";

/**
 * Client for the user's scheduled agent jobs: a cron schedule, a prompt, and
 * the agent that runs it, plus the history of what each run answered.
 *
 * Separate from `lib/agents`, which covers the jobs the app ships as code. Those
 * are a configuration surface — is the nightly digest running — while these are
 * the user's own work, created and read from the Jobs panel.
 */

/** The modes `claude --permission-mode` accepts, in the order the editor offers
 *  them. Mirrors `CLAUDE_PERMISSION_MODES` in the sidecar, which validates. */
export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

/**
 * Modes that let a headless run act without asking anyone. The editor says so
 * beside the choice: on a schedule, with nobody watching, this is the setting
 * that decides how much a poisoned file in the working directory can do.
 */
export const UNATTENDED_PERMISSION_MODES: ReadonlySet<string> = new Set([
  "bypassPermissions",
  "dontAsk",
]);

/** Which agent runs the job, and what that agent needs to know. */
export type AgentJobTarget =
  | { kind: "yarvis"; specialist: string | null }
  | {
      kind: "claude-code";
      /** Absolute directory the headless session starts in. */
      cwd: string;
      model: string | null;
      permissionMode: ClaudePermissionMode | null;
    };

export type AgentJobKind = AgentJobTarget["kind"];

export interface ScheduledJob {
  id: string;
  name: string;
  description: string | null;
  cron: string;
  prompt: string;
  enabled: boolean;
  target: AgentJobTarget;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledJobRun {
  id: string;
  jobId: string;
  trigger: "schedule" | "manual";
  status: "running" | "ok" | "error";
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ScheduledJobStatus {
  job: ScheduledJob;
  /** Null for a disabled job, or one whose expression no longer parses. */
  nextRunAt: string | null;
  cronValid: boolean;
  lastRun: ScheduledJobRun | null;
  running: boolean;
}

/** The fields the editor submits; the id and timestamps are the server's. */
export interface ScheduledJobInput {
  name: string;
  description: string | null;
  cron: string;
  prompt: string;
  enabled: boolean;
  target: AgentJobTarget;
}

export interface RunOutcome {
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

export const listScheduledJobs = async (): Promise<ScheduledJobStatus[]> =>
  (await request<{ jobs: ScheduledJobStatus[] }>("/api/jobs/agent-jobs")).jobs;

export const createScheduledJob = async (input: ScheduledJobInput): Promise<ScheduledJob> =>
  (await request<{ job: ScheduledJob }>("/api/jobs/agent-jobs", "POST", input)).job;

export const updateScheduledJob = async (
  id: string,
  input: ScheduledJobInput,
): Promise<ScheduledJob> =>
  (await request<{ job: ScheduledJob }>(`/api/jobs/agent-jobs/${id}`, "PUT", input)).job;

export const deleteScheduledJob = (id: string): Promise<{ deleted: boolean }> =>
  request(`/api/jobs/agent-jobs/${id}`, "DELETE");

export const listScheduledJobRuns = async (id: string): Promise<ScheduledJobRun[]> =>
  (await request<{ runs: ScheduledJobRun[] }>(`/api/jobs/agent-jobs/${id}/runs`)).runs;

/** Runs a job now, schedule or not. "busy" means a copy is already in flight. */
export const runScheduledJob = (id: string): Promise<RunOutcome> =>
  request(`/api/jobs/agent-jobs/${id}/run`, "POST", {});

/** A blank job, for the editor's "new job" state. */
export function emptyJobInput(): ScheduledJobInput {
  return {
    name: "",
    description: null,
    // Weekday mornings: a schedule that reads clearly and is easy to change,
    // rather than one that fires while the user is still reading the form.
    cron: "0 9 * * 1-5",
    prompt: "",
    enabled: true,
    target: { kind: "yarvis", specialist: null },
  };
}

export function jobInputFrom(job: ScheduledJob): ScheduledJobInput {
  return {
    name: job.name,
    description: job.description,
    cron: job.cron,
    prompt: job.prompt,
    enabled: job.enabled,
    target: job.target,
  };
}

/** How long a finished run took, or null while it is still going. */
export function runDurationMs(run: ScheduledJobRun): number | null {
  if (!run.finishedAt) return null;
  return new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
}

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Weekday mornings", cron: "0 9 * * 1-5" },
  { label: "Daily at 18:00", cron: "0 18 * * *" },
  { label: "Monday mornings", cron: "0 9 * * 1" },
];
