import { useEffect, useMemo, useRef } from "react";
import type { AttentionItem } from "../../lib/attention";
import { markAttention, useAttentionItems } from "../../lib/attentionStore";
import { type MergeRisk, mergeAnnouncementOf } from "../../lib/headsDown";

const RISK_STYLE: Record<MergeRisk, string> = {
  high: "border-red-500/60 bg-red-500/15 text-red-200",
  medium: "border-amber-500/60 bg-amber-500/15 text-amber-200",
  low: "border-emerald-500/60 bg-emerald-500/15 text-emerald-200",
  unknown: "border-zinc-500/60 bg-zinc-500/15 text-zinc-200",
};

/** The pass's own judgment, so the badge says whose it is. */
const RISK_LABEL: Record<MergeRisk, string> = {
  high: "Heads down rates it high risk",
  medium: "Heads down rates it medium risk",
  low: "Heads down rates it low risk",
  unknown: "Risk not assessed",
};

/**
 * Pops up over any page when heads-down mode merges a PR. The merge doesn't
 * wait on the user; this makes sure they notice it. Dismissing it clears the
 * attention item behind it. The newest merge shows first.
 */
export default function MergeAlert({ onOpen }: { onOpen: (item: AttentionItem) => void }) {
  const items = useAttentionItems();
  const merges = useMemo(
    () =>
      items.flatMap((item) => {
        const merge = mergeAnnouncementOf(item);
        return merge ? [{ item, merge }] : [];
      }),
    [items],
  );
  const current = merges[0];
  const currentId = current?.item.id;
  const dismissRef = useRef<HTMLButtonElement>(null);

  // Keyed on the id, so an unrelated bell update doesn't move focus.
  useEffect(() => {
    if (!currentId) return;
    dismissRef.current?.focus();
    // Captured and stopped here, so Escape doesn't also close a dialog underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void markAttention(currentId, "dismissed");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [currentId]);

  if (!current) return null;
  const { item, merge } = current;
  const pr =
    merge.number === null
      ? "A PR in a workspace"
      : merge.repo
        ? `${merge.repo}#${merge.number}`
        : `#${merge.number}`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Heads down is merging ${pr}`}
        className="relative w-[520px] max-w-full rounded-lg border-2 border-amber-500/70 bg-zinc-900 shadow-2xl"
      >
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">
                Heads down is merging a PR
              </div>
              <div className="mt-1 text-lg font-semibold text-zinc-100">{pr}</div>
              {merge.title && (
                <div className="text-sm text-zinc-300">
                  <span className="text-zinc-500">PR title: </span>
                  {merge.title}
                </div>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${RISK_STYLE[merge.risk]}`}
            >
              {RISK_LABEL[merge.risk]}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm text-zinc-300">{merge.why}</p>
          {merges.length > 1 && (
            <p className="text-xs text-zinc-500">
              {merges.length - 1} more merge{merges.length > 2 ? "s" : ""} to look at.
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            {item.navTarget?.type === "pr"
              ? "Open PR"
              : item.navTarget?.type === "workspace"
                ? "Open workspace"
                : "Open Heads down"}
          </button>
          <button
            ref={dismissRef}
            type="button"
            onClick={() => void markAttention(item.id, "dismissed")}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
