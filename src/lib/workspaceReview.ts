import { useCallback, useEffect, useState } from "react";
import { ensureOk, sidecarFetch } from "./api";

/**
 * Self-review comments a reviewer leaves on their own workspace diffs before
 * anything is published. They live only in the local database, so the notes
 * never reach a PR where other people would read feedback that goes obsolete
 * the moment the agent acts on it.
 *
 * The diff tab and the workspace's comment list both read through the store
 * below, so a comment written on a line shows up in the list — and a resolve or
 * delete from the list disappears from the diff — without either view polling.
 */

export interface ReviewComment {
  id: string;
  workspaceRepoId: string;
  path: string;
  /** 1-based right-hand (new file) line the comment starts on. */
  startLine: number;
  /** Equal to `startLine` for a single-line comment. */
  endLine: number;
  /** Worktree HEAD when the note was written; null on a branch with no commits. */
  commitSha: string | null;
  body: string;
  /** Null while the comment is still open. */
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateReviewCommentInput {
  workspaceRepoId: string;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
}

export async function listReviewComments(workspaceId: string): Promise<ReviewComment[]> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/review-comments`);
  await ensureOk(res, "list review comments");
  return res.json();
}

export async function createReviewComment(
  workspaceId: string,
  input: CreateReviewCommentInput,
): Promise<ReviewComment> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/review-comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "save review comment");
  return res.json();
}

export async function updateReviewComment(
  workspaceId: string,
  commentId: string,
  patch: { body?: string; resolved?: boolean },
): Promise<ReviewComment> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/review-comments/${commentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "update review comment");
  return res.json();
}

export async function deleteReviewComment(workspaceId: string, commentId: string): Promise<void> {
  const res = await sidecarFetch(`/api/workspaces/${workspaceId}/review-comments/${commentId}`, {
    method: "DELETE",
  });
  await ensureOk(res, "delete review comment");
}

/** A file's line range as a reviewer reads it: `12` for one line, `12-18` for many. */
export function formatLineRange(comment: Pick<ReviewComment, "startLine" | "endLine">): string {
  return comment.startLine === comment.endLine
    ? String(comment.startLine)
    : `${comment.startLine}-${comment.endLine}`;
}

/**
 * The whole review as text to paste into an agent session: one numbered entry
 * per open comment, each naming the file, the lines, and the commit it was
 * written against. Resolved comments are left out — the point of resolving one
 * is that it no longer needs acting on.
 *
 * `repoName` maps a workspace repo id to a display name so a multi-repo
 * workspace's paths aren't ambiguous; it returns null for a single-repo
 * workspace, where the repo prefix would only be noise.
 */
export function formatReviewComments(
  comments: ReviewComment[],
  repoName: (workspaceRepoId: string) => string | null,
): string {
  const open = comments.filter((c) => c.resolvedAt === null);
  if (open.length === 0) return "";

  const lines = [
    `Please address the following ${open.length} review ${
      open.length === 1 ? "comment" : "comments"
    } on the current changes:`,
    "",
  ];
  open.forEach((comment, i) => {
    const repo = repoName(comment.workspaceRepoId);
    const location = `${repo ? `${repo}/` : ""}${comment.path}:${formatLineRange(comment)}`;
    // The sha is provenance, not an instruction — abbreviated so it reads as a
    // reference rather than filling the line.
    const at = comment.commitSha ? ` (at ${comment.commitSha.slice(0, 7)})` : "";
    lines.push(`${i + 1}. ${location}${at}`);
    for (const bodyLine of comment.body.split("\n")) {
      lines.push(`   ${bodyLine}`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

/**
 * One entry per workspace whose comments are on screen. Both the diff tabs and
 * the comments list subscribe to the same entry, so a write from either is
 * reflected in the other immediately rather than on some later refetch.
 */
const byWorkspace = new Map<string, ReviewComment[]>();
const listeners = new Map<string, Set<() => void>>();
/** Loads in flight, so several views mounting at once make one request. */
const loads = new Map<string, Promise<ReviewComment[]>>();

function notify(workspaceId: string): void {
  for (const listener of listeners.get(workspaceId) ?? []) listener();
}

function setComments(workspaceId: string, comments: ReviewComment[]): void {
  byWorkspace.set(workspaceId, comments);
  notify(workspaceId);
}

function loadInto(workspaceId: string): Promise<ReviewComment[]> {
  const inFlight = loads.get(workspaceId);
  if (inFlight) return inFlight;
  const load = listReviewComments(workspaceId)
    .then((loaded) => {
      setComments(workspaceId, loaded);
      return loaded;
    })
    .finally(() => loads.delete(workspaceId));
  loads.set(workspaceId, load);
  return load;
}

/**
 * A workspace's review comments, kept in step across every view showing them.
 * The mutations returned here write through the sidecar and then update the
 * shared list, so callers never hold their own copy.
 */
export function useReviewComments(workspaceId: string): {
  comments: ReviewComment[];
  error: string | null;
  add: (input: CreateReviewCommentInput) => Promise<void>;
  setResolved: (commentId: string, resolved: boolean) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
} {
  const [comments, setLocal] = useState<ReviewComment[]>(() => byWorkspace.get(workspaceId) ?? []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const sync = () => {
      if (live) setLocal(byWorkspace.get(workspaceId) ?? []);
    };
    const subscribers = listeners.get(workspaceId) ?? new Set<() => void>();
    subscribers.add(sync);
    listeners.set(workspaceId, subscribers);

    sync();
    loadInto(workspaceId).catch((e) => {
      if (live) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      live = false;
      subscribers.delete(sync);
      if (subscribers.size === 0) {
        listeners.delete(workspaceId);
        // Nothing is showing this workspace any more, so a stale list can't be
        // read back the next time one of its views mounts.
        byWorkspace.delete(workspaceId);
      }
    };
  }, [workspaceId]);

  /**
   * Applies a mutation and republishes the list. `rethrow` is for the composer,
   * which reports the failure beside the text the user typed and must not treat
   * a failed save as a save; the resolve/delete buttons have nothing to keep, so
   * for them the failure only needs to reach `error`.
   */
  const run = useCallback(
    async (mutate: () => Promise<ReviewComment[]>, rethrow: boolean) => {
      setError(null);
      try {
        setComments(workspaceId, await mutate());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        if (rethrow) throw e;
      }
    },
    [workspaceId],
  );

  const current = () => byWorkspace.get(workspaceId) ?? [];

  return {
    comments,
    error,
    add: (input) =>
      run(async () => {
        const created = await createReviewComment(workspaceId, input);
        return [...current(), created];
      }, true),
    setResolved: (commentId, resolved) =>
      run(async () => {
        const updated = await updateReviewComment(workspaceId, commentId, { resolved });
        return current().map((c) => (c.id === commentId ? updated : c));
      }, false),
    remove: (commentId) =>
      run(async () => {
        await deleteReviewComment(workspaceId, commentId);
        return current().filter((c) => c.id !== commentId);
      }, false),
  };
}
