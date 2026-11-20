import { useState } from "react";
import {
  archiveReviewWorkspace,
  type ReviewWorkspaceSummary,
} from "../../lib/reviewWorkspaces/api";
import { invalidateReviewWorkspace, useReviewWorkspaces } from "../../lib/reviewWorkspaces/cache";
import { openInReviewWorkspace } from "../../lib/reviewWorkspaces/open";
import PrLocator from "../pr/PrLocator";
import RefreshingIndicator from "../RefreshingIndicator";
import ConfirmDialog from "./ConfirmDialog";
import { prColor } from "./prColors";
import { prLabel } from "./ReviewNav";
import { forgetReviewWorkspace } from "./selection";

/** "3h ago" for the list; exact time in the tooltip. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never opened";
  const minutes = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const opened = (w: ReviewWorkspaceSummary) => w.lastOpenedAt ?? w.createdAt;

/**
 * The Review tab's front page: paste a PR to review it, or pick up a review
 * workspace where it was left, most recently opened first.
 */
export default function ReviewWorkspaceList({ onSelect }: { onSelect: (id: string) => void }) {
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, refreshing } = useReviewWorkspaces(showArchived);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<ReviewWorkspaceSummary | null>(null);
  const all = [...(data ?? [])].sort((a, b) => opened(b).localeCompare(opened(a)));
  const shown = showArchived ? all : all.filter((w) => w.status !== "archived");

  const attempt = async (op: () => Promise<void>) => {
    setActionError(null);
    try {
      await op();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-zinc-100">Review</h2>
          <RefreshingIndicator active={refreshing} />
        </div>
        <div>
          <p className="mb-2 text-sm text-zinc-400">
            Paste a PR to check it out and review it in tabs. A PR already in a workspace opens
            there.
          </p>
          <PrLocator onOpen={(pr) => void attempt(() => openInReviewWorkspace(pr.ref, pr.title))} />
        </div>
        {(error || actionError) && <p className="text-sm text-red-400">{actionError ?? error}</p>}
        <section>
          <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
            Workspaces
          </h3>
          {data && shown.length === 0 && (
            <p className="text-sm text-zinc-500">No review workspaces yet.</p>
          )}
          <ul className="divide-y divide-zinc-800 border border-zinc-800">
            {shown.map((w) => (
              <li key={w.id} className="group flex items-center gap-3 px-3 py-2 hover:bg-zinc-900">
                <button
                  type="button"
                  onClick={() => onSelect(w.id)}
                  className="flex min-w-0 flex-1 flex-col items-start text-left"
                >
                  <span className="truncate text-sm text-zinc-100">{w.name}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs">
                    {[...w.prs]
                      .sort((a, b) => a.position - b.position)
                      .map((pr) => (
                        <span
                          key={pr.id}
                          className={`flex items-center gap-1 ${prColor(pr.colorIndex).text}`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${prColor(pr.colorIndex).bg}`}
                            aria-hidden
                          />
                          {prLabel(pr)}
                        </span>
                      ))}
                    {w.prs.length === 0 && <span className="text-zinc-500">No PRs</span>}
                  </span>
                </button>
                {w.status !== "active" && (
                  <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
                    {w.status}
                  </span>
                )}
                <span
                  className="shrink-0 text-xs text-zinc-500"
                  title={w.lastOpenedAt ?? undefined}
                >
                  {ago(w.lastOpenedAt)}
                </span>
                {w.status === "active" && (
                  <button
                    type="button"
                    onClick={() => setArchiving(w)}
                    title="Remove the checkouts and put this workspace away"
                    className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 opacity-0 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    Archive
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="mt-2 text-xs text-zinc-500 hover:text-zinc-300"
          >
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </section>
      </div>
      {archiving && (
        <ConfirmDialog
          title={`Archive “${archiving.name}”?`}
          confirmLabel="Archive"
          busyLabel="Archiving…"
          onConfirm={async () => {
            await archiveReviewWorkspace(archiving.id);
            invalidateReviewWorkspace(archiving.id);
            forgetReviewWorkspace(archiving.id);
            setArchiving(null);
          }}
          onClose={() => setArchiving(null)}
        >
          Removes the PRs' checkouts from disk and puts the workspace under Show archived. The
          clones are kept, so reviewing the same repos again starts faster.
        </ConfirmDialog>
      )}
    </div>
  );
}
