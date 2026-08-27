import { useCallback, useEffect, useState } from "react";
import { needsUpdateCount } from "../../lib/pr/stack";
import type { MergeMethod, StackEntry } from "../../lib/pr/types";
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
 * `gh stack view` plus a provider round trip per layer, and a stack changes on
 * the user's own actions rather than on its own, so it loads on open and offers
 * a refresh.
 */

const MERGE_METHODS: { value: MergeMethod; label: string }[] = [
  { value: "SQUASH", label: "Squash" },
  { value: "MERGE", label: "Merge commit" },
  { value: "REBASE", label: "Rebase" },
];

/**
 * Which layer a "merge the stack" action should stop at: the one the workspace
 * is on. Everything below it merges too; everything above is likelier to be
 * unfinished, and `gh stack merge <pr>` is scoped exactly this way.
 */
function mergeTarget(stack: WorkspaceStack["stack"]): StackEntry | null {
  const entries = stack?.entries ?? [];
  const current = entries.find((e) => e.isCurrent && !e.merged && e.number > 0);
  return current ?? null;
}

export default function WorkspaceStackView({
  workspaceId,
  repo,
}: {
  workspaceId: string;
  repo: WorkspaceRepoDetail;
}) {
  const [data, setData] = useState<WorkspaceStack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod>("SQUASH");
  // The merge is irreversible and merges layers the user can't see from the
  // button, so it takes a second press with the range spelled out.
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeOutput, setMergeOutput] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await workspaceRepoStack(workspaceId, repo.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [workspaceId, repo.id]);

  useEffect(() => {
    setData(null);
    setConfirming(false);
    setMergeOutput(null);
    void load();
  }, [load]);

  const stack = data?.stack ?? null;
  const target = mergeTarget(stack);
  const below = target ? stack!.entries.indexOf(target) + 1 : 0;
  const stale = needsUpdateCount(stack);

  const merge = async () => {
    if (!target) return;
    setMerging(true);
    setMergeOutput(null);
    try {
      const result = await mergeWorkspaceRepoStack(workspaceId, repo.id, target.number, method);
      setMergeOutput(result.output || (result.merged ? "Merged." : "Nothing was merged."));
      await load();
    } catch (e) {
      setMergeOutput(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
      setConfirming(false);
    }
  };

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;
  if (!stack || stack.entries.length === 0) {
    return (
      <div className="space-y-2 text-xs text-zinc-500">
        <p>
          No stack for <span className="font-mono">{repo.branch}</span>.
        </p>
        {data.ghStackError && <p className="text-zinc-600">gh stack: {data.ghStackError}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
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

      {stale > 0 && (
        <p className="text-amber-400">
          {stale} branch{stale === 1 ? "" : "es"} need restacking — run{" "}
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
                onChange={(e) => setMethod(e.target.value as MergeMethod)}
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
                    ? `Merge ${below} PR${below === 1 ? "" : "s"} — confirm`
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
              Merges every layer from <span className="font-mono">{stack.trunk}</span> up to #
              {target.number}, or none of them.
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
