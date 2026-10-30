import { useEffect, useMemo, useState } from "react";
import { cancelAgentRun, streamAgentRun } from "../../../lib/agentRuns";
import { postPrComment } from "../../../lib/pr/api";
import { prDetailKey } from "../../../lib/pr/cache";
import { invalidate } from "../../../lib/resourceCache";
import { invalidateLastReview, seenAt } from "../../../lib/reviewWorkspaces/sinceReview";
import {
  startVerification,
  type VerificationSize,
} from "../../../lib/reviewWorkspaces/verification";
import LoadingIndicator from "../../LoadingIndicator";
import { Spinner } from "../../ThinkingIndicator";
import {
  reportOf,
  useLatestVerification,
  useReviewChangedFiles,
  useReviewTree,
  useReviewViewed,
  verificationKey,
} from "./reviewData";
import { CostLine, FileNotices, fileNotices } from "./SizeNotices";
import type { TabContext } from "./types";
import VerificationReportView, {
  type OpenLocation,
  type PostFinding,
} from "./VerificationReportView";
import {
  type CheckProgress,
  initialProgress,
  type RunProgress,
  reduceProgress,
} from "./verificationProgress";

/**
 * Follows one run's events into its progress, from the start (the stream
 * replays what already happened) to its `done`. When it ends the PR's latest
 * report is re-read, which is where the finished report comes from.
 */
export function useVerificationRun(prId: string, runId: string | null): RunProgress | null {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  useEffect(() => {
    setProgress(runId ? initialProgress() : null);
    if (!runId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamAgentRun(runId, abort.signal)) {
          setProgress((p) => reduceProgress(p ?? initialProgress(), event));
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        setProgress((p) => ({
          ...(p ?? initialProgress()),
          error: `Lost track of the run: ${e instanceof Error ? e.message : String(e)}`,
        }));
      }
      if (!abort.signal.aborted) invalidate(verificationKey(prId));
    })();
    return () => abort.abort();
  }, [prId, runId]);
  return progress;
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/**
 * What a run on this PR will and won't see, and what it may cost, asked
 * before a large or over-budget run starts.
 */
function SizeWarning({ size }: { size: VerificationSize }) {
  return (
    <div className="space-y-1">
      {size.large && (
        <div>
          This PR is large: {size.files} files, {size.changedLines} changed lines. The checks read
          every file's diff, so the run takes longer and costs more than usual.
        </div>
      )}
      <FileNotices notices={fileNotices(size)} />
      <CostLine {...size} />
    </div>
  );
}

function CheckLine({ check }: { check: CheckProgress }) {
  const icon =
    check.state === "running" ? (
      <Spinner />
    ) : check.state === "done" ? (
      <span className="text-emerald-400">✓</span>
    ) : check.state === "failed" ? (
      <span className="text-red-400">✕</span>
    ) : (
      <span className="text-zinc-600">○</span>
    );
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="flex w-4 justify-center">{icon}</span>
      <span className={check.state === "waiting" ? "text-zinc-500" : "text-zinc-200"}>
        {check.label}
      </span>
      {check.activity && check.state === "running" && (
        <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
          {check.activity}
        </span>
      )}
    </li>
  );
}

/**
 * The verification report: an agent review of the whole change — summary,
 * the files that must be read, risk, and the completeness, test, complexity,
 * performance, comment, observability and quality checks — run on the PR's
 * checkout. Shows the run's progress while it works and the report once it
 * is done; every location in it opens the file's diff at that line.
 */
export default function VerificationTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const latest = useLatestVerification(workspaceId, pr.id);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // A large PR, or one the estimate says will outrun the budget, asks first.
  const [confirmingLarge, setConfirmingLarge] = useState(false);

  const run = latest.data?.run ?? null;
  const runningHere = run?.status === "running" && run.live ? run.id : null;
  const followId = startedId ?? runningHere;
  const progress = useVerificationRun(pr.id, followId);
  const running = followId !== null && progress !== null && progress.finished === null;
  const runningElsewhere = !running && run?.status === "running" && !run.live;
  const report = reportOf(latest.data);
  const good = latest.data?.lastSucceeded ?? null;
  const size = latest.data?.size ?? null;
  const viewed = useReviewViewed(ctx.prRef);

  const start = async (confirmed = false) => {
    if ((size?.large || size?.overBudget) && !confirmed) {
      setConfirmingLarge(true);
      return;
    }
    setConfirmingLarge(false);
    setStarting(true);
    setActionError(null);
    try {
      const { runId } = await startVerification(workspaceId, pr.id);
      setStartedId(runId);
      invalidate(verificationKey(pr.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!followId) return;
    setActionError(null);
    try {
      await cancelAgentRun(followId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  // The report is model-written, so only a path the PR actually has is a link.
  const changed = useReviewChangedFiles(workspaceId, pr);
  const tree = useReviewTree(workspaceId, pr);
  const known = useMemo(
    () => new Set([...(changed.data?.files.map((f) => f.path) ?? []), ...(tree.data?.paths ?? [])]),
    [changed.data, tree.data],
  );
  const open: OpenLocation = {
    open: (path, line) =>
      ctx.openTab({ kind: "diff", prId: pr.id, path, ...(line ? { revealLine: line } : {}) }),
    canOpen: (path) => known.has(path),
  };
  const postFinding: PostFinding = async ({ path, line }, body) => {
    await postPrComment(ctx.prRef, { path, line, body }, seenAt(pr));
    invalidateLastReview(ctx.prRef);
    // The new thread arrives with the PR's detail, in the Comments tab and the diff.
    invalidate(prDetailKey(ctx.prRef));
  };

  const notReady = pr.status !== "ready" || pr.worktreeStatus !== "ready";
  const finishedRun = running ? null : run;
  const failed = finishedRun?.status === "failed";
  const cancelled = finishedRun?.status === "cancelled";

  if (latest.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the verification report…" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Verification report</h2>
          {good && report && !running && (
            <span className="text-xs text-zinc-500">
              at {short(good.headSha)}
              {good.run.costUsd != null ? ` · $${good.run.costUsd.toFixed(2)}` : ""}
            </span>
          )}
          <span className="ml-auto flex gap-2">
            {running ? (
              <button
                type="button"
                onClick={() => void cancel()}
                className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            ) : (
              !runningElsewhere && (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting || notReady}
                  title={notReady ? "Waiting for the checkout" : undefined}
                  className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
                >
                  {starting ? "Starting…" : run ? "Re-run" : "Run verification"}
                </button>
              )
            )}
          </span>
        </div>

        {confirmingLarge && size && !running && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-200"
          >
            <SizeWarning size={size} />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void start(true)}
                className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600"
              >
                Run anyway
              </button>
              <button
                type="button"
                onClick={() => setConfirmingLarge(false)}
                className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {!confirmingLarge && size && !running && (
          // Even on a small PR, say up front what the run won't read whole.
          <div className="text-xs text-zinc-400" data-testid="file-notices">
            <FileNotices notices={fileNotices(size)} />
          </div>
        )}

        {actionError && (
          <p role="alert" className="text-xs text-red-400">
            {actionError}
          </p>
        )}
        {latest.error && <p className="text-xs text-red-400">{latest.error}</p>}

        {!run && !running && (
          <p className="text-sm text-zinc-400">
            Agents read every changed file's diff and report what the change does, which files must
            be read, how risky it is, and whether it is complete, tested, simple, fast, well
            commented, observable and well written. Checks that pass say so in a line, and the
            report lists any file the checks didn't read.
          </p>
        )}

        {running && progress && (
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <ul className="space-y-1">
              {progress.checks.map((c) => (
                <CheckLine key={c.agent} check={c} />
              ))}
            </ul>
            {progress.activity && (
              <p className="truncate font-mono text-[11px] text-zinc-500">{progress.activity}</p>
            )}
          </div>
        )}
        {progress?.error && !running && !failed && (
          <p className="text-xs text-red-400">{progress.error}</p>
        )}

        {runningElsewhere && (
          <p className="text-sm text-zinc-400">
            A report is being written by another Yarvis window.{" "}
            <button
              type="button"
              onClick={() => void latest.refresh()}
              className="text-sky-400 hover:text-sky-300"
            >
              Check again
            </button>
          </p>
        )}

        {failed && (
          <div
            role="alert"
            className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300"
          >
            {report ? "The re-run failed" : "The last run failed"}:{" "}
            {finishedRun?.error ?? progress?.error ?? "no reason given"}
            {report && good && (
              <span className="block text-xs text-red-300/80">
                Below is the last good report, from {short(good.headSha)}.
              </span>
            )}
          </div>
        )}
        {cancelled && (
          <p className="text-sm text-zinc-500">
            The last run was cancelled.
            {report && good && ` Below is the last good report, from ${short(good.headSha)}.`}
          </p>
        )}

        {report && good && !good.current && !running && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
            This report is for an older head; the pull request has moved to{" "}
            {short(latest.data?.headSha)}.
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || notReady}
              className="ml-auto rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-900/40 disabled:opacity-50"
            >
              Re-run
            </button>
          </div>
        )}

        {report && !running && (
          <VerificationReportView
            report={report}
            onOpen={open}
            viewed={viewed.viewed}
            onPostFinding={postFinding}
          />
        )}
      </div>
    </div>
  );
}
