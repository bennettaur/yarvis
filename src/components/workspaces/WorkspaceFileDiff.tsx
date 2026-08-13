import { useCallback, useEffect, useState } from "react";
import { workspaceRepoFileDiff } from "../../lib/workspaces";
import DiffView from "../diff/DiffView";

/**
 * A workspace diff tab's body: loads the unified diff for one changed file in a
 * repo's worktree and renders it read-only via the shared {@link DiffView}. The
 * diff is fetched live (the worktree keeps changing as work continues), so a
 * manual refresh button lets the user re-pull without reopening the tab.
 */
export default function WorkspaceFileDiff({
  workspaceId,
  repoId,
  path,
}: {
  workspaceId: string;
  repoId: string;
  path: string;
}) {
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const diff = await workspaceRepoFileDiff(workspaceId, repoId, path);
      setPatch(diff.patch);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, repoId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={path}>
          {path}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : patch === null ? (
          <p className="p-3 text-xs text-zinc-500">Loading diff…</p>
        ) : (
          <DiffView patch={patch} path={path} />
        )}
      </div>
    </div>
  );
}
