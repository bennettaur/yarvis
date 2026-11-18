import { useCallback, useRef, useState } from "react";
import type { PrSummary } from "../../lib/pr/types";
import { listReviewWorkspaces, type ReviewWorkspaceSummary } from "../../lib/reviewWorkspaces/api";
import { addToReviewWorkspace, openInReviewWorkspace } from "../../lib/reviewWorkspaces/open";
import { useDismiss } from "./useDismiss";

/**
 * The classic review's way into a review workspace: the main button opens the
 * workspace already holding this PR (or starts one), and the arrow lists the
 * other workspaces to add it to, for reviewing it beside another PR.
 */
export default function OpenInReviewWorkspace({ pr }: { pr: PrSummary }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<ReviewWorkspaceSummary[] | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(root, menu !== null, closeMenu);

  const attempt = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMenu(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleMenu = async () => {
    if (menu) {
      setMenu(null);
      return;
    }
    setError(null);
    try {
      setMenu((await listReviewWorkspaces()).filter((w) => w.status === "active"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div ref={root} className="relative flex">
      <button
        type="button"
        onClick={() => void attempt(() => openInReviewWorkspace(pr.ref, pr.title))}
        disabled={busy}
        title={error ?? "Open this PR in a review workspace: a local checkout with tabs"}
        className={`rounded-l-md border border-zinc-700 px-2 py-1.5 text-xs hover:bg-zinc-800 disabled:opacity-50 ${
          error ? "text-red-300" : "text-zinc-200"
        }`}
      >
        {busy ? "Opening…" : error ? "Couldn't open — retry" : "Open in review workspace"}
      </button>
      <button
        type="button"
        onClick={() => void toggleMenu()}
        disabled={busy}
        aria-label="Add to review workspace…"
        title="Add to review workspace…"
        aria-expanded={menu !== null}
        className="rounded-r-md border border-l-0 border-zinc-700 px-1.5 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
      >
        ▾
      </button>
      {menu && (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-0.5 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
          <div className="px-2 py-1 text-xs text-zinc-500">Add to review workspace</div>
          {menu.length === 0 && (
            <div className="px-2 py-1 text-xs text-zinc-500">No review workspaces yet.</div>
          )}
          {menu.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => void attempt(() => addToReviewWorkspace(w.id, pr.ref))}
              className="flex items-center justify-between gap-2 truncate rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800"
            >
              <span className="truncate">{w.name}</span>
              <span className="shrink-0 text-zinc-500">
                {w.prs.length} PR{w.prs.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
