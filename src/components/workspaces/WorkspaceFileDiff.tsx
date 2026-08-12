import { useCallback, useEffect, useMemo, useState } from "react";
import { useReviewComments } from "../../lib/workspaceReview";
import { workspaceRepoFileDiff } from "../../lib/workspaces";
import ReviewDiffBody from "./ReviewDiffBody";

/**
 * A workspace diff tab's body: loads the unified diff for one changed file in a
 * repo's worktree and renders it with the self-review comment layer, so the
 * work can be reviewed here rather than on a PR. The diff is fetched live (the
 * worktree keeps changing as work continues), so a manual refresh button lets
 * the user re-pull without reopening the tab.
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
  const review = useReviewComments(workspaceId);

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

  const fileComments = useMemo(
    () => review.comments.filter((c) => c.workspaceRepoId === repoId && c.path === path),
    [review.comments, repoId, path],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300" title={path}>
          {path}
        </span>
        {fileComments.length > 0 && (
          <span className="shrink-0 text-xs text-zinc-500">
            {fileComments.length} {fileComments.length === 1 ? "comment" : "comments"}
          </span>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {review.error && <p className="shrink-0 px-3 py-1 text-xs text-red-400">{review.error}</p>}
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-3 text-xs text-red-400">{error}</p>
        ) : patch === null ? (
          <p className="p-3 text-xs text-zinc-500">Loading diff…</p>
        ) : (
          <ReviewDiffBody
            patch={patch}
            path={path}
            workspaceRepoId={repoId}
            comments={fileComments}
            onAdd={review.add}
            onToggleResolved={(comment) => void review.toggleResolved(comment)}
            onDelete={(comment) => void review.remove(comment.id)}
          />
        )}
      </div>
    </div>
  );
}
