import { useEffect, useState } from "react";
import { requestOpenWorkspace } from "../../lib/nav";
import { refKey } from "../../lib/pr/ref";
import type { PrRef } from "../../lib/pr/types";
import { findWorkspaceForPr, type WorkspaceForPr } from "../../lib/workspaces";

/**
 * When this PR was raised from an active workspace, shows a button that jumps
 * back to it (via the cross-tab open-workspace request). Only GitHub PRs are
 * tracked by the workspace poller, so Azure refs never match and render nothing.
 * Renders nothing while loading or when there's no match, so it stays out of the
 * way for PRs opened outside a workspace.
 */
export default function PrWorkspaceLink({ prRef }: { prRef: PrRef }) {
  const [workspace, setWorkspace] = useState<WorkspaceForPr | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ref identity, not the unstable ref object
  useEffect(() => {
    if (prRef.provider !== "github") {
      setWorkspace(null);
      return;
    }
    let live = true;
    findWorkspaceForPr(prRef.owner, prRef.repo, prRef.number)
      .then((w) => live && setWorkspace(w))
      .catch(() => live && setWorkspace(null));
    return () => {
      live = false;
    };
  }, [refKey(prRef)]);

  if (!workspace) return null;

  return (
    <button
      type="button"
      onClick={() => requestOpenWorkspace({ id: workspace.id })}
      title={`Jump to the “${workspace.name}” workspace`}
      className="flex shrink-0 items-center gap-1 rounded-md border border-indigo-700/60 bg-indigo-900/30 px-2 py-1.5 text-xs text-indigo-200 hover:bg-indigo-900/60"
    >
      <span aria-hidden>⤴</span>
      <span className="max-w-[10rem] truncate">Workspace: {workspace.name}</span>
    </button>
  );
}
