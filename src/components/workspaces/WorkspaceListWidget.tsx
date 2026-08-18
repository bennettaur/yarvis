import { useEffect, useState } from "react";
import { listWorkspaces, type WorkspaceStatus, type WorkspaceSummary } from "../../lib/workspaces";
import WorkspacePrIcons from "./WorkspacePrIcons";

const STATUS_COLOR: Record<WorkspaceStatus, string> = {
  creating: "text-amber-400",
  active: "text-emerald-400",
  archiving: "text-amber-400",
  archived: "text-zinc-500",
  error: "text-red-400",
};

/** Read-only Omni widget: all workspaces with status + repos. Self-contained. */
export default function WorkspaceListWidget() {
  const [items, setItems] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkspaces()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="p-3 text-sm text-red-400">{error}</p>;
  if (!items) return <p className="p-3 text-sm text-zinc-500">Loading…</p>;
  if (items.length === 0) return <p className="p-3 text-sm text-zinc-500">No workspaces.</p>;

  return (
    <ul className="divide-y divide-zinc-800">
      {items.map((ws) => (
        <li key={ws.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
          <div className="min-w-0">
            <div className="truncate text-zinc-200">{ws.name}</div>
            {ws.repoNames.length > 0 && (
              <div className="truncate text-xs text-zinc-500">{ws.repoNames.join(", ")}</div>
            )}
          </div>
          <span className="flex shrink-0 items-center gap-1.5">
            <WorkspacePrIcons prs={ws.prs} />
            <span className={`text-xs ${STATUS_COLOR[ws.status]}`}>{ws.status}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
