import { useEffect } from "react";
import { acknowledgeAlarm, snoozeAlarm, useRingingAlarms } from "../../lib/alarmStore";
import type { Alarm } from "../../lib/alarms";
import type { AttentionItem, AttentionKind } from "../../lib/attention";
import type { AttentionGroup } from "../../lib/attentionGroups";
import { markAttention, markAttentionScope, useAttentionGroups } from "../../lib/attentionStore";
import { formatRelativeTime } from "../../lib/time";
import type { WipItem, WipSource } from "../../lib/wip";
import { sessionTabTitle } from "../shell/terminalTabs/sessionIds";

/**
 * A right slide-out panel with three streams: "Ringing" (alarms that have fired
 * and nobody dismissed), "Needs you now" (pending attention items — Claude
 * sessions blocked on the user, or the chat agent asking for a decision) and
 * "In progress" (the ambient WIP roll-up). Modeled on the Omni Chat overlay: a
 * fixed, z-50 layer that stays mounted while hidden so the store subscription
 * persists, with a click-away backdrop and Esc-to-close.
 *
 * Alarms live in the Rust core rather than the sidecar's attention table, so
 * they get their own section fed by the alarm store — the same shape the WIP
 * roll-up already uses.
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

/**
 * Names the tabs a group's items came from, so a workspace row says *which*
 * session is blocked. Falls back to nothing when no session resolves to a tab
 * (the label is a bonus on top of the lead item's own body).
 */
function tabSummary(sessionKeys: string[]): string | null {
  const titles = sessionKeys
    .map(sessionTabTitle)
    .filter((title): title is string => Boolean(title));
  const unique = [...new Set(titles)];
  return unique.length > 0 ? unique.join(", ") : null;
}

/**
 * One row per origin rather than per item: repeat asks from the same workspace
 * or tab collapse into a single entry with a count, and dismissing it clears the
 * whole group in one request.
 */
function AttentionGroupRow({
  group,
  onOpen,
}: {
  group: AttentionGroup;
  onOpen: (item: AttentionItem) => void;
}) {
  const { lead, items } = group;
  const tabs = tabSummary(group.sessionKeys);
  const dismiss = () => {
    // A sourceless nudge has no scope to clear, so it goes item by item.
    if (group.scope.workspaceId || group.scope.sessionKey) {
      void markAttentionScope(group.scope, "dismissed");
    } else {
      void markAttention(lead.id, "dismissed");
    }
  };

  return (
    <li className="group flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/60">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[lead.kind]}`} />
      <button type="button" onClick={() => onOpen(lead)} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-zinc-100">{lead.title}</span>
          {items.length > 1 && (
            <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {items.length}
            </span>
          )}
        </div>
        {tabs && <div className="truncate text-xs text-zinc-500">{tabs}</div>}
        {lead.body && <div className="truncate text-xs text-zinc-400">{lead.body}</div>}
        <div className="mt-0.5 text-[11px] text-zinc-500">{formatRelativeTime(lead.createdAt)}</div>
      </button>
      <button
        type="button"
        aria-label={items.length > 1 ? `Dismiss ${items.length} items` : "Dismiss"}
        onClick={dismiss}
        className="shrink-0 rounded px-1 text-zinc-600 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100"
      >
        ✕
      </button>
    </li>
  );
}

function RingingAlarmRow({ alarm, onOpen }: { alarm: Alarm; onOpen: () => void }) {
  return (
    <li className="flex items-start gap-3 px-4 py-3 hover:bg-zinc-800/60">
      <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm text-zinc-100">{alarm.label}</div>
        <div className="mt-0.5 text-[11px] text-zinc-500">
          {formatRelativeTime(new Date(alarm.fireAtMs).toISOString())}
        </div>
      </button>
      <button
        type="button"
        onClick={() => void snoozeAlarm(alarm.id, 5)}
        className="shrink-0 rounded px-1 text-xs text-zinc-500 hover:text-zinc-200"
      >
        Snooze
      </button>
      <button
        type="button"
        onClick={() => void acknowledgeAlarm(alarm.id)}
        className="shrink-0 rounded px-1 text-xs text-zinc-400 hover:text-zinc-100"
      >
        Dismiss
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
  onOpenAlarms,
}: {
  open: boolean;
  onClose: () => void;
  onOpenAttention: (item: AttentionItem) => void;
  wip: WipItem[];
  wipLoading: boolean;
  onOpenWip: (item: WipItem) => void;
  onOpenAlarms: () => void;
}) {
  const groups = useAttentionGroups();
  const ringing = useRingingAlarms();

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
          {/* Only shown when something is actually ringing — an empty alarm
              section would push the two permanent streams down for nothing. */}
          {ringing.length > 0 && (
            <>
              <SectionHeader label="Ringing" count={ringing.length} />
              <ul className="divide-y divide-zinc-800">
                {ringing.map((alarm) => (
                  <RingingAlarmRow key={alarm.id} alarm={alarm} onOpen={onOpenAlarms} />
                ))}
              </ul>
            </>
          )}

          <SectionHeader label="Needs you now" count={groups.length} />
          {groups.length === 0 ? (
            <p className="px-4 py-4 text-xs text-zinc-500">Nothing needs you right now.</p>
          ) : (
            <ul className="divide-y divide-zinc-800">
              {groups.map((group) => (
                <AttentionGroupRow key={group.key} group={group} onOpen={onOpenAttention} />
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
