import type { AgentRunStatus } from "../agentRuns";
import { ensureOk, sidecarFetch } from "../api";

/**
 * Client for a review PR's verification report: starting one, and reading the
 * latest. Following a run live goes through `lib/agentRuns`, like any other
 * headless Claude Code run.
 */

export type Severity = "high" | "medium" | "low";

export interface VerificationFinding {
  title: string;
  detail: string;
  severity: Severity;
  path?: string;
  line?: number;
}

/** One check's verdict; `pass` exactly when it has no findings. */
export interface VerificationCheck {
  status: "pass" | "issues";
  findings: VerificationFinding[];
}

export interface VerificationConcern {
  title: string;
  detail: string;
  path?: string;
  line?: number;
}

export interface VerificationMustRead {
  path: string;
  reason: string;
  lines?: { start: number; end: number };
}

/** Mirrors the sidecar's `VerificationReport` (`reviewWorkspaces/verification.ts`). */
export interface VerificationReport {
  summary: string;
  mustRead: VerificationMustRead[];
  risk: {
    level: "low" | "medium" | "high";
    clientImpact: string;
    mitigations: string[];
    concerns: VerificationConcern[];
  };
  completeness: VerificationCheck;
  tests: VerificationCheck;
  complexity: VerificationCheck;
  performance: VerificationCheck;
  comments: VerificationCheck;
}

/** The checks shown as one row each, in the order the report lists them. */
export const VERIFICATION_CHECKS = [
  "completeness",
  "tests",
  "complexity",
  "performance",
  "comments",
] as const;
export type VerificationCheckKey = (typeof VERIFICATION_CHECKS)[number];

/** A verification run as the route returns it. */
export interface VerificationRun {
  id: string;
  kind: string;
  targetKey: string;
  status: AgentRunStatus;
  /** The report, once the run has succeeded. */
  result: VerificationReport | null;
  error: string | null;
  costUsd: number | null;
  meta: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  /** Whether this sidecar is running it, so its events can be followed live. */
  live: boolean;
}

export interface LatestVerification {
  run: VerificationRun | null;
  /** The PR's head now. */
  headSha: string | null;
  /** True when the run was made against that head. */
  current: boolean;
  /**
   * The newest run that finished with a report (the same as `run` when that
   * one succeeded), so a failed or cancelled re-run doesn't hide the last good
   * report. `headSha` is the commit it was made against.
   */
  lastSucceeded: {
    run: Omit<VerificationRun, "live">;
    headSha: string | null;
    current: boolean;
  } | null;
  /**
   * The PR's size, to warn before a run that will leave files out and cost
   * more. Null until the PR is ready to read.
   */
  size: { files: number; changedLines: number; large: boolean } | null;
}

const path = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/verification`;

export async function latestVerification(
  workspaceId: string,
  prId: string,
): Promise<LatestVerification> {
  const res = await sidecarFetch(path(workspaceId, prId));
  await ensureOk(res, "read verification report");
  return res.json();
}

/**
 * Starts a report, or answers with the run already going for this PR
 * (`existing`). Follow it with `streamAgentRun(runId)`.
 */
export async function startVerification(
  workspaceId: string,
  prId: string,
): Promise<{ runId: string; existing: boolean }> {
  const res = await sidecarFetch(path(workspaceId, prId), { method: "POST" });
  await ensureOk(res, "start verification report");
  return res.json();
}
