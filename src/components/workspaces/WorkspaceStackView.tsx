import { useCallback, useEffect, useRef, useState } from "react";
import { currentLayer, mergePlan, needsUpdateCount } from "../../lib/pr/stack";
import type { MergeMethod } from "../../lib/pr/types";
import {
  mergeWorkspaceRepoStack,
  type WorkspaceRepoDetail,
  type WorkspaceStack,
  workspaceRepoStack,
} from "../../lib/workspaces";
import PrStackList from "../pr/PrStackList";

/**
 * The workspace detail's Stack tab: the chain of pull requests this repo's
 * branch sits in, and the one action a stack has that a single PR doesn't —
 * merging the whole thing up to a chosen layer.
 *
 * Unlike the other right-column views this one isn't polled. Reading it costs a
 * `gh stack view` subprocess plus provider round trips, where those views cost
 * one git command, and a stack changes on the user's own actions rather than on
 * its own — so it loads on open and offers a refresh.
 */

/**
 * The strategies `gh stack merge` takes, plus the empty default. A repo can
 * disallow any of the three and the stack read carries no per-repo merge
 * settings, so the default sends none and leaves `gh` on whatever the repo last
 * used — the same thing that happens when someone runs the command by hand.
 */
const MERGE_METHODS: { value: MergeMethod | ""; label: string }[] = [
  { value: "", label: "Last-used method" },
  { value: "SQUASH", label: "Squash" },
  { value: "MERGE", label: "Merge commit" },
  { value: "REBASE", label: "Rebase" },
];

export default function WorkspaceStackView({
  workspaceId,
  repo,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
}) {
  const [data, setData] = useState<WorkspaceStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod | "">("");
  // The merge is irreversible and takes layers the button alone doesn't show,
  // so it needs a second press with the count spelled out.
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeOutput, setMergeOutput] = useState<string | null>(null);

  // Switching repos, or pressing Refresh twice, can leave an older read still
  // in flight; only the newest one may write back. The sibling views in
  // `WorkspaceSidePanel` and the PR cache both guard this the same way.
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    setError(null);
    try {
      const next = await workspaceRepoStack(workspaceId, repo.id);
      if (seq === latest.current) setData(next);
    } catch (e) {
      // Whatever is on screen stays: a failed refresh is a reason to say so,
      // not to take away the stack the reader was looking at.
      if (seq === latest.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId, repo.id]);

  useEffect(() => {
    setData(null);
    setConfirming(false);
    setMergeOutput(null);
    void load();
  }, [load]);

  const stack = data?.stack ?? null;
  const target = currentLayer(stack);
  // What the confirm button promises, and what the sidecar recomputes before it
  // merges anything.
  const plan = stack && target ? mergePlan(stack, target.number) : [];
  const staleCount = needsUpdateCount(stack);

  const merge = async () => {
    if (!target) return;
    setMerging(true);
    setMergeOutput(null);
    try {
      const result = await mergeWorkspaceRepoStack(
        workspaceId,
        repo.id,
        target.number,
        plan,
        method || undefined,
      );
      setMergeOutput(result.output || (result.merged ? "Merged." : "Nothing was merged."));
      await load();
    } catch (e) {
      setMergeOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
      setConfirming(false);
    }
  };

  if (!data) {
    return error ? (
      <p className="text-xs text-red-400">{error}</p>
    ) : (
      <p className="text-xs text-zinc-500">Loading…</p>
    );
  }
  if (!stack || stack.entries.length === 0) {
    return (
      <div className="space-y-2 text-xs text-zinc-500">
        <p>
          No stack for <span className="font-mono">{repo.branch}</span>.
        </p>
        {data.ghStackError && <p className="text-zinc-600">gh stack: {data.ghStackError}</p>}
        {data.prStackError && <p className="text-zinc-600">GitHub: {data.prStackError}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      {error && <p className="text-red-400">Couldn't refresh: {error}</p>}

      <div className="flex items-center gap-2 text-zinc-500">
        <span>
          {stack.entries.length} PR{stack.entries.length === 1 ? "" : "s"}
          {stack.stackNumber !== null && ` · stack #${stack.stackNumber}`}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      <PrStackList stack={stack} />

      {data.prStackError && (
        <p className="text-zinc-600">
          Checks and reviews are unavailable ({data.prStackError}), so each layer shows only what{" "}
          <span className="font-mono">gh stack</span> knows.
        </p>
      )}

      {staleCount > 0 && (
        <p className="text-amber-400">
          {staleCount} branch{staleCount === 1 ? " needs" : "es need"} restacking — run{" "}
          <span className="font-mono">gh stack rebase</span> in this workspace.
        </p>
      )}

      {data.ghStackError ? (
        // Without the CLI the membership is only inferred, and `gh stack merge`
        // is the only way to merge a stack — so say why the button is absent
        // rather than leaving a stack that apparently cannot be merged.
        <p className="text-zinc-600">
          Derived from branch names; <span className="font-mono">gh stack</span> is unavailable here
          ({data.ghStackError}), so the stack can't be merged from yarvis.
        </p>
      ) : (
        target && (
          <div className="space-y-1 border-t border-zinc-800 pt-2">
            <div className="flex items-center gap-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as MergeMethod | "")}
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs outline-none"
              >
                {MERGE_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={merging}
                onClick={() => (confirming ? void merge() : setConfirming(true))}
                className="rounded-md border border-violet-700/60 bg-violet-900/30 px-2 py-1 text-violet-200 hover:bg-violet-900/60 disabled:opacity-50"
              >
                {merging
                  ? "Merging…"
                  : confirming
                    ? `Merge ${plan.length} PR${plan.length === 1 ? "" : "s"} — confirm`
                    : `Merge stack up to #${target.number}`}
              </button>
              {confirming && !merging && (
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="text-zinc-500 hover:text-zinc-300"
                >
                  Cancel
                </button>
              )}
            </div>
            <p className="text-zinc-600">
              Merges {plan.map((n) => `#${n}`).join(", ")} — all of them or none.
            </p>
          </div>
        )
      )}

      {mergeOutput && (
        <pre className="whitespace-pre-wrap rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
          {mergeOutput}
        </pre>
      )}
    </div>
  );
}
