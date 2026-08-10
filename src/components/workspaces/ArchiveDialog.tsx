import { useState } from "react";
import { archiveWorkspace, type WorkspaceDetail } from "../../lib/workspaces";

/**
 * Confirms archiving a workspace: captures a summary + PR URL (prefilled from a
 * linked PR the poller saw, preferring a merged one) and starts the teardown.
 * The teardown runs in the sidecar's background, so the dialog closes as soon
 * as the workspace reads `archiving` rather than waiting for the worktrees to
 * go. A worktree that wouldn't remove (uncommitted work) leaves the workspace
 * in `archiving` with the repo's error, which reopening this dialog shows
 * alongside a Force remove.
 */
export default function ArchiveDialog({
  detail,
  onClose,
  onArchived,
  onError,
}: {
  detail: WorkspaceDetail;
  onClose: () => void;
  onArchived: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const linkedPr =
    detail.repos.find((r) => r.pr?.prState === "merged")?.pr ??
    detail.repos.find((r) => r.pr?.prUrl && r.pr.prState !== "closed")?.pr;
  const [summary, setSummary] = useState(detail.summary ?? "");
  const [prUrl, setPrUrl] = useState(detail.mergedPrUrl ?? linkedPr?.prUrl ?? "");
  const [busy, setBusy] = useState(false);

  const openTaskCount = detail.tasks.filter((t) => t.status === "open").length;

  // A previous attempt that couldn't remove a worktree left the workspace in
  // `archiving` with the failure recorded (and cleared again the moment a retry
  // starts). Discarding that uncommitted work needs an explicit force.
  const needsForce = detail.status === "archiving" && detail.error !== null;
  const blockedError = detail.repos
    .filter((wr) => wr.status === "error")
    .map((wr) => `${wr.repo.name}: ${wr.error ?? "worktree could not be removed"}`)
    .join("; ");

  const run = async (force: boolean) => {
    setBusy(true);
    try {
      await archiveWorkspace(detail.id, {
        summary: summary.trim() || null,
        mergedPrUrl: prUrl.trim() || null,
        force,
      });
      await onArchived();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5">
        <h3 className="text-sm font-medium text-zinc-100">Archive “{detail.name}”</h3>
        <p className="text-xs text-zinc-500">
          Removes the worktrees from disk
          {openTaskCount > 0 && ` and marks ${openTaskCount} linked task(s) done`}. Runs in the
          background — you can keep working while it finishes.
        </p>

        <label className="block text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Summary</span>
          <textarea
            value={summary}
            placeholder="What was done to complete the task"
            rows={3}
            onChange={(e) => setSummary(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </label>

        <label className="block text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">PR URL</span>
          <input
            value={prUrl}
            placeholder="https://github.com/owner/repo/pull/123"
            onChange={(e) => setPrUrl(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </label>

        {needsForce && <p className="text-xs text-red-400">{blockedError || detail.error}</p>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Cancel
          </button>
          {needsForce ? (
            <button
              onClick={() => void run(true)}
              disabled={busy}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium hover:bg-red-500 disabled:opacity-40"
            >
              Force remove
            </button>
          ) : (
            <button
              onClick={() => void run(false)}
              disabled={busy}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
            >
              {busy ? "Archiving…" : "Archive"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
