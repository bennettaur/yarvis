import { useState } from "react";
import { archiveWorkspace, type WorkspaceDetail } from "../../lib/workspaces";

/**
 * Confirms archiving a workspace: captures a summary + PR URL (prefilled from a
 * linked PR the poller saw, preferring a merged one) and tears down the
 * worktrees. A dirty worktree surfaces the error and offers a Force remove.
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
  const [needsForce, setNeedsForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const openTaskCount = detail.tasks.filter((t) => t.status === "open").length;

  const run = async (force: boolean) => {
    setBusy(true);
    setDialogError(null);
    try {
      const result = await archiveWorkspace(detail.id, {
        summary: summary.trim() || null,
        mergedPrUrl: prUrl.trim() || null,
        force,
      });
      if (result.errors.length > 0) {
        // Worktrees with uncommitted work need an explicit force confirmation.
        setNeedsForce(true);
        setDialogError(result.errors.map((e) => `${e.repo}: ${e.message}`).join("; "));
        return;
      }
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
          {openTaskCount > 0 && ` and marks ${openTaskCount} linked task(s) done`}.
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

        {dialogError && <p className="text-xs text-red-400">{dialogError}</p>}

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
