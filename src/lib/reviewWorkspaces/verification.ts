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

/** Something in a must-read file that already looks off or unclear. */
export interface VerificationMustReadFlag {
  note: string;
  line?: number;
}

export interface VerificationMustRead {
  path: string;
  reason: string;
  lines?: { start: number; end: number };
  /** Absent on a report from before must-reads carried flags. */
  flags?: VerificationMustReadFlag[];
}

/**
 * Which changed files the run's agents read, counted by the sidecar from the
 * run's Read calls (`reviewWorkspaces/coverage.ts`), not taken from them.
 */
export interface VerificationCoverage {
  /** Files at least one check read in full. */
  examined: number;
  total: number;
  /** Lockfiles and generated, vendored or minified files whose first page was read. */
  skimmed: { path: string; kind: string }[];
  notExamined: { path: string; reason: string }[];
  /** Per check: source files in its lane it didn't read itself. */
  laneGaps: { check: string; paths: string[] }[];
}

/** Counting the coverage failed: the report stands, what it read is unknown. */
export interface UnknownCoverage {
  unknown: true;
}

export const coverageKnown = (
  c: VerificationCoverage | UnknownCoverage | undefined,
): c is VerificationCoverage => !!c && !("unknown" in c);

/** Mirrors the sidecar's `CoveredReport` (`reviewWorkspaces/verification.ts`). */
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
  /** Absent on a report from before these checks were added. */
  observability?: VerificationCheck;
  quality?: VerificationCheck;
  /** Absent on a report from before coverage was counted. */
  coverage?: VerificationCoverage | UnknownCoverage;
}

/** Mirrors the sidecar's `VerificationSize`: the facts a warning before a run states. */
export interface VerificationSize {
  files: number;
  changedLines: number;
  /** Big enough that the UI asks before starting. */
  large: boolean;
  /** Changed files with no text diff, so no patch for the agents. */
  binary: string[];
  /** Changed files whose diff is too large, so the agents see only its start. */
  truncated: string[];
  /** Lockfiles and generated, vendored or minified files, which the agents only skim. */
  skimmed: string[];
  /** A rough estimate for the configured model. */
  estimatedCostUsd: number;
  budgetUsd: number;
  /** The estimate is over the budget: the run may stop before it answers. */
  overBudget: boolean;
}

/** The checks shown as one row each, in the order the report lists them. */
export const VERIFICATION_CHECKS = [
  "completeness",
  "tests",
  "complexity",
  "performance",
  "comments",
  "observability",
  "quality",
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
   * The PR's size, to warn before a run that reads a lot or may outrun its
   * budget. Null until the PR is ready to read.
   */
  size: VerificationSize | null;
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
