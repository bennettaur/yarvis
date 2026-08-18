import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../../lib/clipboard";
import {
  formatCommentLocation,
  formatReviewComments,
  isResolved,
  useReviewComments,
} from "../../lib/workspaceReview";
import type { WorkspaceRepoDetail } from "../../lib/workspaces";
import { FEEDBACK_MS } from "../CopyButton";
import ReviewCommentCard from "./ReviewCommentCard";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABELS: Record<CopyState, string> = {
  idle: "Copy for Claude",
  copied: "Copied",
  failed: "Copying failed",
};

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
  const { comments, error, toggleResolved, remove } = useReviewComments(workspaceId);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  // A single-repo workspace has nothing to disambiguate, so the repo name would
  // only lengthen every location line.
  const repoNameFor = (workspaceRepoId: string): string | null =>
    repos.length > 1 ? (repos.find((r) => r.id === workspaceRepoId)?.repo.name ?? null) : null;

  const open = comments.filter((c) => !isResolved(c));

  const copy = async () => {
    try {
      await writeClipboard(formatReviewComments(comments, repoNameFor));
      setCopyState("copied");
    } catch (e) {
      console.error("[workspaces] copying the review comments failed:", e);
      setCopyState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), FEEDBACK_MS);
  };

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span>
          {open.length} open
          {comments.length > open.length && ` · ${comments.length - open.length} resolved`}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={open.length === 0}
          className={`ml-auto rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50 ${
            copyState === "failed" ? "text-red-400" : ""
          }`}
        >
          {COPY_LABELS[copyState]}
        </button>
      </div>
      {comments.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No comments yet. Open a changed file's diff and drag down the line numbers to leave one.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((comment) => (
            <li key={comment.id}>
              <ReviewCommentCard
                comment={comment}
                location={formatCommentLocation(comment, repoNameFor)}
                onOpenLocation={() => onOpenFile(comment.workspaceRepoId, comment.path)}
                onToggleResolved={() => void toggleResolved(comment)}
                onDelete={() => void remove(comment.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
