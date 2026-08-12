import { useState } from "react";
import { writeClipboard } from "../../lib/clipboard";
import {
  formatLineRange,
  formatReviewComments,
  useReviewComments,
} from "../../lib/workspaceReview";
import type { WorkspaceRepoDetail } from "../../lib/workspaces";
import ReviewCommentCard from "./ReviewCommentCard";

/**
 * Every self-review comment in the workspace, in the order they were written.
 * The copy button is the point of the view: it turns the whole review into the
 * text to paste into an agent session, which is what the notes were collected
 * for. Resolved comments stay listed (so a decision isn't lost) but are left
 * out of the copied text.
 */
export default function WorkspaceReviewComments({
  workspaceId,
  repos,
  onOpenFile,
}: {
  workspaceId: string;
  repos: WorkspaceRepoDetail[];
  onOpenFile: (workspaceRepoId: string, path: string) => void;
}) {
  const { comments, error, setResolved, remove } = useReviewComments(workspaceId);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  // A single-repo workspace has nothing to disambiguate, so the repo name would
  // only lengthen every location line.
  const repoName = (workspaceRepoId: string): string | null =>
    repos.length > 1 ? (repos.find((r) => r.id === workspaceRepoId)?.repo.name ?? null) : null;

  const open = comments.filter((c) => c.resolvedAt === null);

  const copy = async () => {
    try {
      await writeClipboard(formatReviewComments(comments, repoName));
      setCopyError(null);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setCopyError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-400">{error}</p>}
      {copyError && <p className="text-xs text-red-400">{copyError}</p>}
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span>
          {open.length} open
          {comments.length > open.length && ` · ${comments.length - open.length} resolved`}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={open.length === 0}
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
        >
          {copied ? "Copied" : "Copy for Claude"}
        </button>
      </div>
      {comments.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No comments yet. Open a changed file's diff and drag down the line numbers to leave one.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => {
            const repo = repoName(comment.workspaceRepoId);
            const location = `${repo ? `${repo}/` : ""}${comment.path}:${formatLineRange(comment)}`;
            return (
              <li key={comment.id}>
                <ReviewCommentCard
                  comment={comment}
                  location={location}
                  onOpenLocation={() => onOpenFile(comment.workspaceRepoId, comment.path)}
                  onToggleResolved={() => void setResolved(comment.id, comment.resolvedAt === null)}
                  onDelete={() => void remove(comment.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
