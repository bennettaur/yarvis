import { formatRelativeTime } from "../../lib/time";
import { formatLineRange, type ReviewComment } from "../../lib/workspaceReview";

/**
 * One self-review comment, styled after a PR review comment so a workspace diff
 * reads the same way a PR does. Shared by the diff's inline layer and the
 * workspace's comment list, which differ only in whether the location line is
 * worth showing.
 */
export default function ReviewCommentCard({
  comment,
  location,
  onOpenLocation,
  onToggleResolved,
  onDelete,
}: {
  comment: ReviewComment;
  /** File/line prefix, for the list view where the comment is out of context. */
  location?: string;
  /** Set where the location can be followed back to the diff it was left on. */
  onOpenLocation?: () => void;
  onToggleResolved: () => void;
  onDelete: () => void;
}) {
  const resolved = comment.resolvedAt !== null;
  const label = location ?? `line ${formatLineRange(comment)}`;
  return (
    <div
      className={`rounded-lg border p-3 text-sm ${
        resolved
          ? "border-zinc-800 bg-zinc-900/30 text-zinc-500"
          : "border-zinc-800 bg-zinc-900/50 text-zinc-300"
      }`}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
        {onOpenLocation ? (
          <button
            type="button"
            onClick={onOpenLocation}
            title={`Open diff for ${label}`}
            className="min-w-0 truncate font-mono hover:text-zinc-200 hover:underline"
          >
            {label}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono">{label}</span>
        )}
        <span className="shrink-0">{formatRelativeTime(comment.createdAt)}</span>
        {resolved && (
          <span className="shrink-0 rounded bg-emerald-900/40 px-1.5 py-0.5 text-emerald-300">
            resolved
          </span>
        )}
        <span className="ml-auto flex shrink-0 gap-1">
          <button
            type="button"
            onClick={onToggleResolved}
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800 hover:text-zinc-200"
          >
            {resolved ? "Reopen" : "Resolve"}
          </button>
          <button
            type="button"
            onClick={onDelete}
            title="Delete comment"
            aria-label="Delete comment"
            className="rounded border border-zinc-700 px-1.5 py-0.5 hover:bg-zinc-800 hover:text-red-300"
          >
            ×
          </button>
        </span>
      </div>
      <p className={`whitespace-pre-wrap ${resolved ? "line-through" : ""}`}>{comment.body}</p>
      {comment.commitSha && (
        <p className="mt-1 font-mono text-xs text-zinc-600">at {comment.commitSha.slice(0, 7)}</p>
      )}
    </div>
  );
}
