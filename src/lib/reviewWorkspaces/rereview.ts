import type { AgentRunStatus } from "../agentRuns";
import { ensureOk, sidecarFetch } from "../api";
import type { VerificationCoverage } from "./verification";

/**
 * Client for a review PR's "What's changed" summary: an agent's judgement of
 * whether the reviewer's comments were addressed since their last review, and
 * which other changes still need them. Following a run live goes through
 * `lib/agentRuns`, like any other headless Claude Code run.
 */

export type CommentVerdict = "addressed" | "partly" | "not_addressed" | "disagreed" | "unclear";

/** One of the reviewer's comments, judged. Mirrors the sidecar's `RereviewComment`. */
export interface RereviewComment {
  /** The short id the run used (`T1`, `C1`); only for keys. */
  threadId: string;
  /** A review thread, or a comment on the PR itself. */
  kind: "thread" | "conversation";
  /** The provider's id of the thread or comment. */
  providerId: string;
  path: string | null;
  line: number | null;
  /** The thread was resolved when the run started; a resolved thread isn't outstanding. */
  resolved: boolean;
  verdict: CommentVerdict;
  /** Where the agent saw the fix or the problem; agent-written. */
  evidence: { path?: string; line?: number; note: string };
  /** For `disagreed`: the agent's summary of the author's reply. */
  replySummary?: string;
  /** What the agent said before the server found it unsupported. */
  downgradedFrom?: CommentVerdict;
}

export interface RereviewChange {
  path: string;
  lines?: { start: number; end: number };
  kind: "needs_review" | "minor";
  reason: string;
}

export interface Rereview {
  summary: string;
  verdict: "ready_to_approve" | "needs_another_look";
  verdictReason: string;
  /** The server's own line when it couldn't take the agent's answer as given. */
  serverNote?: string;
  comments: RereviewComment[];
  newChanges: RereviewChange[];
  /** Threads resolved before the review with nothing said since: not judged again. */
  settled?: { providerId: string; path: string | null; line: number | null }[];
  /**
   * Which changed files the agent read, counted by the sidecar; a file it
   * didn't is among `newChanges` as needing review. Absent on older answers.
   */
  coverage?: VerificationCoverage;
}

/** A re-review run as the route returns it. */
export interface RereviewRun {
  id: string;
  status: AgentRunStatus;
  result: Rereview | null;
  error: string | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  /** The reviewed head it compared from, and the head it compared to. */
  fromHeadSha: string | null;
  toHeadSha: string | null;
}

export interface LatestRereview {
  /** Whether this sidecar is running `run`, so its events can be followed live. */
  run: (RereviewRun & { live: boolean }) | null;
  /** The range a re-review would cover now. */
  fromHeadSha: string | null;
  headSha: string | null;
  /** True when `run` covers that range. */
  current: boolean;
  /** The newest run with an answer, so a failed re-run doesn't hide it. */
  lastSucceeded: {
    run: RereviewRun;
    fromHeadSha: string | null;
    toHeadSha: string | null;
    current: boolean;
  } | null;
}

const path = (workspaceId: string, prId: string, from?: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/rereview${
    from ? `?from=${encodeURIComponent(from)}` : ""
  }`;

export async function latestRereview(
  workspaceId: string,
  prId: string,
  from?: string,
): Promise<LatestRereview> {
  const res = await sidecarFetch(path(workspaceId, prId, from));
  await ensureOk(res, "read the re-review summary");
  return res.json();
}

/**
 * Starts a summary of what changed since `from` (the last review when
 * omitted), or answers with the run already going over the same range.
 */
export async function startRereview(
  workspaceId: string,
  prId: string,
  from?: string,
): Promise<{ runId: string; existing: boolean; fromHeadSha: string; toHeadSha: string }> {
  const res = await sidecarFetch(path(workspaceId, prId, from), { method: "POST" });
  await ensureOk(res, "start the re-review summary");
  return res.json();
}
