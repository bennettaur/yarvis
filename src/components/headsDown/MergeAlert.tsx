import { useEffect, useMemo, useRef } from "react";
import type { AttentionItem } from "../../lib/attention";
import { markAttention, useAttentionItems } from "../../lib/attentionStore";
import { type MergeAnnouncement, mergeAnnouncementOf } from "../../lib/headsDown";

const RISK_STYLE: Record<MergeAnnouncement["risk"], string> = {
  high: "border-red-500/60 bg-red-500/15 text-red-200",
  medium: "border-amber-500/60 bg-amber-500/15 text-amber-200",
  low: "border-emerald-500/60 bg-emerald-500/15 text-emerald-200",
  unknown: "border-amber-500/60 bg-amber-500/15 text-amber-200",
};

const RISK_LABEL: Record<MergeAnnouncement["risk"], string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
  unknown: "Risk not assessed",
};

/**
 * Pops up over any page when heads-down mode merges a PR. The merge doesn't
 * wait on the user; this makes sure they notice it. Dismissing it clears the
 * attention item behind it.
 */
export default function MergeAlert({ onOpen }: { onOpen: (item: AttentionItem) => void }) {
  const items = useAttentionItems();
  const merges = useMemo(
    () =>
      items.flatMap((item) => {
        const merge = mergeAnnouncementOf(item.payload);
        return merge ? [{ item, merge }] : [];
      }),
    [items],
  );
  const current = merges[0];
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void markAttention(current.item.id, "dismissed");
      }
    };
    dismissRef.current?.focus();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;
  const { item, merge } = current;
  const pr = merge.repo ? `${merge.repo}#${merge.number}` : `#${merge.number}`;

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
              {merge.title && <div className="text-sm text-zinc-300">{merge.title}</div>}
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
              {merges.length - 1} more merge{merges.length > 2 ? "s" : ""} after this one.
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
          >
            {item.navTarget?.type === "pr" ? "Open PR" : "Open Heads down"}
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
