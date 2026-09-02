import { useState } from "react";
import type { ToolActivity } from "../lib/chat";

/**
 * What the assistant did during a turn: the tools it called, how each ended,
 * and — when the provider returns it — the reasoning behind them. A turn that
 * spends its time in tools has nothing else to show until the reply arrives,
 * which is indistinguishable from a hung app.
 *
 * Each row is collapsed to a line; the arguments and the result are one click
 * away, because the interesting question ("what did it actually ask for?") is
 * occasional.
 */
export default function TurnActivity({
  activity,
  thinking,
  running,
}: {
  activity: ToolActivity[];
  /** Reasoning streamed for this turn, if any. */
  thinking?: string;
  /** True while the turn is still in flight, so an unsettled row reads as busy. */
  running?: boolean;
}) {
  if (activity.length === 0 && !thinking) return null;
  return (
    <div className="space-y-1">
      {thinking && <ThinkingBlock text={thinking} streaming={running} />}
      {activity.map((entry) => (
        <ToolRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-zinc-400 hover:text-zinc-200"
      >
        <Chevron open={open} />
        <span className={streaming ? "animate-pulse" : ""}>
          {streaming ? "Thinking…" : "Thought about it"}
        </span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap px-2 pb-2 text-zinc-400">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Each outcome's mark, so a row reads without relying on colour alone. */
const STATUS_MARK: Record<ToolActivity["status"], string> = {
  pending: "…",
  ok: "✓",
  error: "✕",
  denied: "⃠",
};

const STATUS_COLOR: Record<ToolActivity["status"], string> = {
  pending: "text-zinc-500",
  ok: "text-emerald-400",
  error: "text-red-400",
  denied: "text-amber-400",
};

function ToolRow({ entry }: { entry: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const hasDetail = entry.args !== undefined || entry.result !== undefined;

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/60 text-xs">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={hasDetail ? open : undefined}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        {hasDetail ? <Chevron open={open} /> : <span className="w-3" />}
        <span className={STATUS_COLOR[entry.status]}>{STATUS_MARK[entry.status]}</span>
        <span className="font-mono text-zinc-300">{entry.name}</span>
        {entry.server && <span className="text-zinc-500">on {entry.server}</span>}
        {entry.status === "denied" && <span className="text-amber-400">denied</span>}
        {entry.durationMs !== undefined && (
          <span className="ml-auto text-zinc-600">{formatDuration(entry.durationMs)}</span>
        )}
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2">
          {entry.args !== undefined && (
            <Detail label="Arguments" body={JSON.stringify(entry.args, null, 2)} />
          )}
          {entry.result !== undefined && <Detail label="Result" body={entry.result} />}
        </div>
      )}
    </div>
  );
}

function Detail({ label, body }: { label: string; body: string }) {
  return (
    <div>
      <div className="mb-0.5 uppercase tracking-wide text-zinc-600">{label}</div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 text-zinc-400">
        {body}
      </pre>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <span aria-hidden="true" className="w-3 text-zinc-600">
      {open ? "▾" : "▸"}
    </span>
  );
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
