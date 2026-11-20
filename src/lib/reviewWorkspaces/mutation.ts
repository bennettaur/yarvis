import type { AgentRunEvent } from "../agentRuns";
import { ensureOk, sidecarFetch, streamSSE } from "../api";

/**
 * Client for a review PR's mutation testing: the latest pass and whether a new
 * one may start, starting and cancelling one, and following it live. Mirrors
 * `sidecar/src/reviewWorkspaces/mutationReport.ts` and `mutationTesting.ts`.
 *
 * Every string a pass reports that came from the PR, its tests or a model
 * (paths, code, test output, evidence, findings) is untrusted: show it as plain
 * text, never as markdown or HTML.
 */

export type MutantOutcome =
  | "killed"
  | "survived"
  | "timeout"
  | "error"
  | "uncovered"
  | "equivalent";

export interface BaselineResult {
  id: string;
  argv: string[];
  testFiles: string[];
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  testCount: number | null;
  problem: string | null;
  excerpt: string;
}

export interface MutantResult {
  id: string;
  path: string;
  line: number;
  oldText: string;
  newText: string;
  description: string;
  rationale: string;
  testCommandId: string | null;
  testFiles: string[];
  outcome: MutantOutcome;
  durationMs: number | null;
  testCount: number | null;
  /** The failing output for a kill, the passing summary for a survivor, or why it proved nothing. */
  evidence: string;
}

export interface MutationExecution {
  baselines: BaselineResult[];
  positiveControls: MutantResult[];
  mutants: MutantResult[];
  planned: number;
}

export type MutationVerdict = "strong" | "mixed" | "weak" | "inconclusive";

export interface MutationSummary {
  killed: number;
  survived: number;
  timeouts: number;
  errors: number;
  uncovered: number;
  equivalent: number;
  valid: number;
  killRate: number | null;
  verdict: MutationVerdict;
  notes: string[];
}

/** A model's explanation of a survivor. */
export interface MutationFinding {
  mutantId: string;
  path: string;
  line: number;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  /** The assertion that would have caught it. */
  suggestion: string;
}

export type MutationPhase =
  | "copying"
  | "planning"
  | "baseline"
  | "control"
  | "mutants"
  | "explaining"
  | "done";

export type MutationRunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface MutationRun {
  id: string;
  headSha: string;
  status: MutationRunStatus;
  phase: MutationPhase;
  execution: MutationExecution | null;
  summary: MutationSummary | null;
  findings: MutationFinding[] | null;
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** Made against the PR's head as it is now. */
  isCurrentHead: boolean;
  /** Running in this sidecar, so its progress can be followed. */
  live: boolean;
}

export interface MutationTestingState {
  run: MutationRun | null;
  headSha: string | null;
  /** Why a new pass can't start now, or null when it can. */
  blocked: { reason: string; needsTestConfirmation?: true } | null;
  /** What the test sandbox does and doesn't protect, to show before starting. */
  sandboxNotes: string;
}

export type MutationProgressEvent =
  | { type: "phase"; phase: MutationPhase; agentRunId?: string }
  | { type: "agent"; phase: "planning" | "explaining"; event: AgentRunEvent }
  | { type: "baseline"; result: BaselineResult }
  | { type: "mutant"; result: MutantResult; index: number; total: number; control: boolean }
  | { type: "error"; message: string }
  | { type: "done"; status: MutationRunStatus }
  | { type: "ping" };

const base = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/mutation-testing`;

export async function getMutationTesting(
  workspaceId: string,
  prId: string,
): Promise<MutationTestingState> {
  const res = await sidecarFetch(base(workspaceId, prId));
  await ensureOk(res, "read mutation testing");
  return res.json();
}

/**
 * Starts a pass on the head the user was looking at, or answers with the one
 * already running. `confirmRunTests` is the user's yes to running the tests of
 * a PR with no setup script.
 */
export async function startMutationTesting(
  workspaceId: string,
  prId: string,
  input: { headSha: string; confirmRunTests?: boolean },
): Promise<{ runId: string; existing: boolean }> {
  const res = await sidecarFetch(base(workspaceId, prId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "start mutation testing");
  return res.json();
}

export async function cancelMutationTesting(workspaceId: string, prId: string): Promise<void> {
  const res = await sidecarFetch(`${base(workspaceId, prId)}/cancel`, { method: "POST" });
  await ensureOk(res, "cancel mutation testing");
}

/** The running pass's events, replayed from its start; ends at once when none is running here. */
export async function* followMutationProgress(
  workspaceId: string,
  prId: string,
  signal?: AbortSignal,
): AsyncGenerator<MutationProgressEvent> {
  for await (const data of streamSSE(`${base(workspaceId, prId)}/progress`, { signal })) {
    yield JSON.parse(data) as MutationProgressEvent;
  }
}
