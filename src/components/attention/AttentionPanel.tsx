import { useEffect } from "react";
import type { AttentionItem, AttentionKind } from "../../lib/attention";
import { markAttention, useAttentionItems } from "../../lib/attentionStore";
import { formatRelativeTime } from "../../lib/time";
import type { WipItem, WipSource } from "../../lib/wip";

/**
 * A right slide-out panel with two streams: "Needs you now" (pending attention
 * items — Claude sessions blocked on the user, or the chat agent asking for a
 * decision) and "In progress" (the ambient WIP roll-up). Modeled on the Omni
 * Chat overlay: a fixed, z-50 layer that stays mounted while hidden so the store
 * subscription persists, with a click-away backdrop and Esc-to-close.
 */

/** Accent colour per attention kind — amber for blocked, others muted. */
const KIND_DOT: Record<AttentionKind, string> = {
  permission: "bg-amber-400",
  idle: "bg-amber-400",
  error: "bg-red-500",
  completed: "bg-emerald-500",
  info: "bg-indigo-400",
};

const WIP_LABEL: Record<WipSource, string> = {
  pr: "PR",
  "starred-pr": "★ PR",
  issue: "Issue",
  task: "Task",
  workspace: "Workspace",
};

function AttentionRow({
  item,
  onOpen,
}: {
  item: AttentionItem;
  onOpen: (item: AttentionItem) => void;
}) {
  return (
    <li className="group flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/60">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[item.kind]}`} />
      <button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm text-zinc-100">{item.title}</div>
        {item.body && <div className="truncate text-xs text-zinc-400">{item.body}</div>}
        <div className="mt-0.5 text-[11px] text-zinc-500">{formatRelativeTime(item.createdAt)}</div>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => void markAttention(item.id, "dismissed")}
        className="shrink-0 rounded px-1 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100"
      >
        ✕
      </button>
    </li>
  );
}

function WipRow({ item, onOpen }: { item: WipItem; onOpen: (item: WipItem) => void }) {
  return (
    <li className="hover:bg-zinc-800/60">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <span className="mt-0.5 shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
          {WIP_LABEL[item.source]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-100">{item.title}</span>
          {item.subtitle && (
            <span className="block truncate text-xs text-zinc-500">{item.subtitle}</span>
          )}
        </span>
      </button>
    </li>
  );
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
      <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</span>
      <span className="text-xs text-zinc-600">{count}</span>
    </div>
  );
}

export default function AttentionPanel({
  open,
  onClose,
  onOpenAttention,
  wip,
  wipLoading,
  onOpenWip,
}: {
  open: boolean;
  onClose: () => void;
  onOpenAttention: (item: AttentionItem) => void;
  wip: WipItem[];
  wipLoading: boolean;
  onOpenWip: (item: WipItem) => void;
}) {
  const attention = useAttentionItems();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-50 ${open ? "" : "hidden"}`}>
      <button
        type="button"
        aria-label="Close attention panel"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
      />
      <aside className="absolute inset-y-0 right-0 flex w-[420px] max-w-[92vw] flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl">
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 px-4">
          <span className="text-sm font-medium text-zinc-200">Attention</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-zinc-500 hover:text-zinc-200"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <SectionHeader label="Needs you now" count={attention.length} />
          {attention.length === 0 ? (
            <p className="px-4 py-4 text-xs text-zinc-500">Nothing needs you right now.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {attention.map((item) => (
                <AttentionRow key={item.id} item={item} onOpen={onOpenAttention} />
              ))}
            </ul>
          )}

          <SectionHeader label="In progress" count={wip.length} />
          {wipLoading && wip.length === 0 ? (
            <p className="px-4 py-4 text-xs text-zinc-500">Loading…</p>
          ) : wip.length === 0 ? (
            <p className="px-4 py-4 text-xs text-zinc-500">No work in progress.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {wip.map((item) => (
                <WipRow key={item.id} item={item} onOpen={onOpenWip} />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
