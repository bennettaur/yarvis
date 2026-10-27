import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MUTATION_TESTING_CONFIG,
  getMutationTestingConfig,
  type MutationTestingConfig,
} from "../../../lib/pr/mutationTestingConfig";
import { invalidate, SIDECAR_FRESHNESS, useCachedResource } from "../../../lib/resourceCache";
import { useReviewChangedFiles } from "../../../lib/reviewWorkspaces/cache";
import {
  cancelMutationTesting,
  followMutationProgress,
  getMutationTesting,
  type MutationRun,
  startMutationTesting,
} from "../../../lib/reviewWorkspaces/mutation";
import LoadingIndicator from "../../LoadingIndicator";
import { Spinner } from "../../ThinkingIndicator";
import MutationReportView, { MutantDiff, OUTCOME_CLASS } from "./MutationReportView";
import {
  initialMutationProgress,
  type MutationProgress,
  PHASE_LABEL,
  PHASES,
  reduceMutationProgress,
} from "./mutationProgress";
import { mutationKey } from "./reviewData";
import type { TabContext } from "./types";
import type { OpenLocation } from "./VerificationReportView";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/**
 * Follows pass `runId`'s events into its progress. The stream replays what
 * already happened, so a reopened tab catches up. However it ends — `done`,
 * closing early, or failing — the progress says it has ended and the stored
 * pass is re-read, which is where the finished report comes from and what
 * says whether the pass is in fact still going.
 */
export function useMutationRun(
  workspaceId: string,
  prId: string,
  runId: string | null,
): MutationProgress | null {
  const [progress, setProgress] = useState<MutationProgress | null>(null);
  useEffect(() => {
    setProgress(runId ? initialMutationProgress() : null);
    if (!runId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of followMutationProgress(workspaceId, prId, abort.signal)) {
          setProgress((p) => reduceMutationProgress(p ?? initialMutationProgress(), event));
        }
        if (abort.signal.aborted) return;
        setProgress((p) => ({ ...(p ?? initialMutationProgress()), streamEnded: true }));
      } catch (e) {
        if (abort.signal.aborted) return;
        setProgress((p) => ({
          ...(p ?? initialMutationProgress()),
          streamEnded: true,
          error: `Lost track of the run: ${e instanceof Error ? e.message : String(e)}`,
        }));
      }
      invalidate(mutationKey(prId));
    })();
    return () => abort.abort();
  }, [workspaceId, prId, runId]);
  return progress;
}

function ProgressView({ progress }: { progress: MutationProgress }) {
  const at = PHASES.indexOf(progress.phase);
  return (
    <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <ol className="space-y-1">
        {PHASES.map((phase, i) => {
          const state = i < at ? "done" : i === at ? "running" : "waiting";
          return (
            <li key={phase} className="flex items-center gap-2 text-sm">
              <span className="flex w-4 justify-center">
                {state === "done" ? (
                  <span className="text-emerald-400">✓</span>
                ) : state === "running" ? (
                  <Spinner />
                ) : (
                  <span className="text-zinc-600">○</span>
                )}
              </span>
              <span className={state === "waiting" ? "text-zinc-500" : "text-zinc-200"}>
                {PHASE_LABEL[phase]}
                {phase === "mutants" && progress.total !== null
                  ? ` · ${progress.mutants.length} of ${progress.total}`
                  : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {progress.activity && (
        <p className="truncate font-mono text-[11px] text-zinc-500">{progress.activity}</p>
      )}
      {progress.baselines.some((b) => !b.passed) && (
        <ul className="space-y-0.5 text-xs text-amber-300">
          {progress.baselines
            .filter((b) => !b.passed)
            .map((b) => (
              <li key={b.id}>
                <span className="font-mono">{b.argv.join(" ")}</span> can't be used:{" "}
                {b.problem ?? "it failed"}
              </li>
            ))}
        </ul>
      )}
      {progress.mutants.length > 0 && (
        <ul className="space-y-1.5">
          {progress.mutants.map((m) => (
            <li key={m.id} className="space-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`w-16 shrink-0 font-medium ${OUTCOME_CLASS[m.outcome]}`}>
                  {m.outcome}
                </span>
                <span className="font-mono text-zinc-400">
                  {m.path}:{m.line}
                </span>
                <span className="text-zinc-300">{m.description}</span>
              </div>
              {m.outcome === "survived" && <MutantDiff mutant={m} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What is said before a pass starts: what it costs and what the sandbox does. */
function StartPanel({
  sandboxNotes,
  config,
  confirmRunTests,
  starting,
  onStart,
  onCancel,
}: {
  sandboxNotes: string;
  config: MutationTestingConfig;
  confirmRunTests: boolean;
  starting: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const budget = config.planningBudgetUsd + config.explanationBudgetUsd;
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm">
      <p className="text-zinc-300">
        Claude Code plans up to {config.maxMutants} small changes to the code this PR touches, then
        the PR's own tests run against each one. Planning and explaining what survives cost up to $
        {budget.toFixed(2)}; the tests run many times, so this can take a while.
      </p>
      {confirmRunTests && (
        <p className="text-amber-200">
          This repo has no setup script, so the tests run on the checkout as it is. Starting is your
          agreement to run this PR's tests.
        </p>
      )}
      <p className="text-xs text-zinc-400">{sandboxNotes}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {starting ? "Starting…" : "Start mutation testing"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/** What stops a pass starting, and the one thing that unblocks it. */
function BlockedNotice({
  reason,
  needsTestConfirmation,
  canReviewSetup,
  onConfirmTests,
  onReviewSetup,
}: {
  reason: string;
  needsTestConfirmation: boolean;
  canReviewSetup: boolean;
  onConfirmTests: () => void;
  onReviewSetup: () => void;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 bg-zinc-900/50 p-3 text-sm">
      <p className="text-zinc-300">Mutation testing can't start: {reason.replace(/\.$/, "")}.</p>
      {needsTestConfirmation ? (
        <button
          type="button"
          onClick={onConfirmTests}
          className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
        >
          Run the tests without a setup script…
        </button>
      ) : (
        canReviewSetup && (
          <button
            type="button"
            onClick={onReviewSetup}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            Review the setup script…
          </button>
        )
      )}
    </div>
  );
}

function RunOutcome({ run }: { run: MutationRun }) {
  if (run.status === "failed") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300"
      >
        The pass failed: {run.error ?? "no reason given"}
        {run.summary && (
          <span className="block text-xs text-red-300/80">Below is what it found before then.</span>
        )}
      </div>
    );
  }
  if (run.status === "cancelled") {
    return (
      <p className="text-sm text-zinc-500">
        The pass was cancelled.{run.summary ? " Below is what it found before then." : ""}
      </p>
    );
  }
  return null;
}

/**
 * Mutation testing for one PR: small deliberate bugs in the code it changes,
 * run against its own tests, to see whether the tests notice. Starts only on
 * code the user agreed to run; shows the pass phase by phase, and then a
 * verdict with each surviving mutant as a finding.
 */
export default function MutationTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const state = useCachedResource(
    mutationKey(pr.id),
    () => getMutationTesting(workspaceId, pr.id),
    SIDECAR_FRESHNESS,
  );
  const changed = useReviewChangedFiles(workspaceId, pr);
  const [config, setConfig] = useState(DEFAULT_MUTATION_TESTING_CONFIG);
  const [confirming, setConfirming] = useState<null | { confirmRunTests: boolean }>(null);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Consent, setup or a new head can each lift (or bring back) what blocks a
  // pass, so the state is asked for again whenever one changes.
  const gateKey = `${pr.setupConsent}:${pr.setupStatus}:${pr.setupHeadSha}:${pr.headSha}`;
  const firstGate = useRef(gateKey);
  useEffect(() => {
    if (gateKey === firstGate.current) return;
    firstGate.current = gateKey;
    invalidate(mutationKey(pr.id));
  }, [gateKey, pr.id]);

  // The budgets shown before starting; the defaults stand in if they can't be read.
  useEffect(() => {
    let live = true;
    getMutationTestingConfig()
      .then((c) => live && setConfig(c))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const data = state.data;
  const run = data?.run ?? null;
  const followId = startedId ?? (run?.status === "running" && run.live ? run.id : null);
  const progress = useMutationRun(workspaceId, pr.id, followId);
  // Running only while both the stream and the stored pass say so: a stream
  // that ends early must not leave the tab spinning on a pass that stopped.
  const streamOpen = progress !== null && progress.finished === null && !progress.streamEnded;
  const running = followId !== null && streamOpen && run?.status === "running";
  const runningElsewhere = !running && run?.status === "running" && !run.live;
  const lostTrack =
    !running && run?.status === "running" && run.live && progress?.streamEnded === true;

  const paths = useMemo(
    () => new Set(changed.data?.files.map((f) => f.path) ?? []),
    [changed.data],
  );
  const open: OpenLocation = {
    open: (path, line) => ctx.openTab({ kind: "diff", prId: pr.id, path, revealLine: line }),
    canOpen: (path) => paths.has(path),
  };

  const start = async (confirmRunTests: boolean) => {
    if (!data?.headSha) return;
    setStarting(true);
    setActionError(null);
    try {
      const { runId } = await startMutationTesting(workspaceId, pr.id, {
        headSha: data.headSha,
        confirmRunTests,
      });
      setConfirming(null);
      setStartedId(runId);
      invalidate(mutationKey(pr.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    setActionError(null);
    try {
      await cancelMutationTesting(workspaceId, pr.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (state.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading mutation testing…" />
      </div>
    );
  }

  const blocked = data?.blocked ?? null;
  const finished = running ? null : run;
  const canStart = !running && !runningElsewhere && !lostTrack && !blocked && !confirming;
  // The prompt has nothing to ask while setup is running, and nothing to show before a checkout.
  const canReviewSetup =
    pr.status === "ready" && pr.worktreeStatus === "ready" && pr.setupStatus !== "running";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Mutation testing</h2>
          {finished && finished.status !== "running" && (
            <span className="text-xs text-zinc-500">
              at {short(finished.headSha)}
              {finished.costUsd != null ? ` · $${finished.costUsd.toFixed(2)}` : ""}
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
              canStart && (
                <button
                  type="button"
                  onClick={() => setConfirming({ confirmRunTests: false })}
                  className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600"
                >
                  {run ? "Re-run" : "Run mutation testing"}
                </button>
              )
            )}
          </span>
        </div>

        {actionError && (
          <p role="alert" className="text-xs text-red-400">
            {actionError}
          </p>
        )}
        {state.error && <p className="text-xs text-red-400">{state.error}</p>}

        {!run && !running && !confirming && (
          <p className="text-sm text-zinc-400">
            Makes small deliberate bugs in the code this PR changes and runs the PR's tests against
            each one. A bug the tests don't notice is a gap in them, and the report says which
            assertion would close it.
          </p>
        )}

        {blocked && !running && !confirming && (
          <BlockedNotice
            reason={blocked.reason}
            needsTestConfirmation={blocked.needsTestConfirmation === true}
            canReviewSetup={canReviewSetup}
            onConfirmTests={() => setConfirming({ confirmRunTests: true })}
            onReviewSetup={ctx.openSetup}
          />
        )}

        {confirming && data && (
          <StartPanel
            sandboxNotes={data.sandboxNotes}
            config={config}
            confirmRunTests={confirming.confirmRunTests}
            starting={starting}
            onStart={() => void start(confirming.confirmRunTests)}
            onCancel={() => setConfirming(null)}
          />
        )}

        {progress?.error && (
          <p role="alert" className="text-xs text-red-400">
            {progress.error}
          </p>
        )}
        {running && progress && <ProgressView progress={progress} />}

        {lostTrack && (
          <p className="text-sm text-zinc-400">
            The pass's progress stopped coming through.{" "}
            <button
              type="button"
              onClick={() => void state.refresh()}
              className="text-sky-400 hover:text-sky-300"
            >
              Check again
            </button>
          </p>
        )}

        {runningElsewhere && (
          <p className="text-sm text-zinc-400">
            A pass is running in another Yarvis window.{" "}
            <button
              type="button"
              onClick={() => void state.refresh()}
              className="text-sky-400 hover:text-sky-300"
            >
              Check again
            </button>
          </p>
        )}

        {finished && <RunOutcome run={finished} />}

        {finished && finished.status !== "running" && !finished.isCurrentHead && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
            This pass is for an older head; the pull request has moved to {short(data?.headSha)}.
            {canStart && " Re-run it to test the code as it is now."}
          </div>
        )}

        {finished?.summary && (
          <MutationReportView
            summary={finished.summary}
            mutants={finished.execution?.mutants ?? []}
            findings={finished.findings ?? []}
            onOpen={open}
          />
        )}
      </div>
    </div>
  );
}
