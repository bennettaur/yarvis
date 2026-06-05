import { useEffect, useState } from "react";
import { type CheckRollup, getWorkspace, type WorkspaceDetail } from "../../lib/workspaces";

const ROLLUP_LABEL: Record<CheckRollup, string> = {
  success: "✓ checks passing",
  failure: "✗ checks failing",
  pending: "● checks running",
  none: "no checks",
};

/** PR-state summary line for a workspace repo, from the poller cache. */
function prSummary(pr: WorkspaceDetail["repos"][number]["pr"]): string {
  if (!pr || pr.lastPolledAt === null) return "not polled";
  if (pr.prNumber === null) return "no PR";
  return `#${pr.prNumber} · ${pr.prState ?? "open"} · ${ROLLUP_LABEL[pr.checkRollup]}`;
}

/**
 * Read-only Omni widget for one workspace named by `workspaceId`: status, its
 * repos (branch + cached PR state) and linked tasks.
 */
export default function WorkspaceWidget({ workspaceId }: { workspaceId: string }) {
  const [detail, setDetail] = useState<WorkspaceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWorkspace(workspaceId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [workspaceId]);

  if (error) return <p className="p-3 text-sm text-red-400">{error}</p>;
  if (!detail) return <p className="p-3 text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-3 p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium text-zinc-100">{detail.name}</span>
        <span className="text-xs text-zinc-500">{detail.status}</span>
      </div>

      <ul className="space-y-1">
        {detail.repos.map((wr) => (
          <li key={wr.id} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              <span className="text-zinc-200">{wr.repo.name}</span>{" "}
              <span className="font-mono text-zinc-500">{wr.branch}</span>
            </span>
            <span className="shrink-0 text-zinc-400">{prSummary(wr.pr)}</span>
          </li>
        ))}
      </ul>

      {detail.tasks.length > 0 && (
        <ul className="space-y-1 border-t border-zinc-800 pt-2 text-xs">
          {detail.tasks.map((t) => (
            <li key={t.id} className={t.status === "done" ? "text-emerald-400" : "text-zinc-300"}>
              {t.status === "done" ? "✓" : "○"} {t.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
