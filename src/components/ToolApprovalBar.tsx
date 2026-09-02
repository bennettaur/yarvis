import { useEffect, useState } from "react";
import type { PendingApproval } from "../lib/chat";

/**
 * The approve/deny prompt for pending MCP tool calls, as one bar above the
 * thread rather than a stack of cards inside it.
 *
 * Several calls can be waiting at once, and rendering one block each pushed the
 * conversation off screen and made the first decision the least reachable. One
 * bar shows the front of the queue with a count, so the thread stays visible
 * and answering is `A` / `D` without leaving the composer.
 *
 * "Always allow" is offered only for MCP tools, and only when the caller can
 * store the decision: a built-in's confirmation depends on how the turn was
 * composed, which is not a preference to record.
 */
export default function ToolApprovalBar({
  approvals,
  onRespond,
  onAlwaysAllow,
}: {
  approvals: PendingApproval[];
  onRespond: (id: string, approved: boolean) => void;
  /** Records standing consent for the tool, then approves this call. */
  onAlwaysAllow?: (approval: PendingApproval) => void;
}) {
  const [showArgs, setShowArgs] = useState(false);
  const current = approvals[0];

  // Answer without leaving the composer. Ignored while the user is typing, so
  // an "a" in a sentence never approves anything.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key !== "a" && key !== "d") return;
      e.preventDefault();
      onRespond(current.id, key === "a");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, onRespond]);

  // Each decision brings the next call forward; its arguments are its own to open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapse per call
  useEffect(() => setShowArgs(false), [current?.id]);

  if (!current) return null;
  const canRemember = onAlwaysAllow && current.toolId?.startsWith("mcp:");

  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-amber-400">Approve?</span>
        <span className="min-w-0 truncate text-zinc-100">
          <span className="font-medium">{current.name}</span>
          {current.server && <span className="text-zinc-400"> on {current.server}</span>}
        </span>
        {approvals.length > 1 && (
          <span className="text-xs text-zinc-400">+{approvals.length - 1} waiting</span>
        )}
        {current.args !== undefined && current.args !== null && (
          <button
            type="button"
            onClick={() => setShowArgs((v) => !v)}
            aria-expanded={showArgs}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            {showArgs ? "Hide arguments" : "Arguments"}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canRemember && (
            <button
              type="button"
              onClick={() => onAlwaysAllow?.(current)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Always allow
            </button>
          )}
          <button
            type="button"
            onClick={() => onRespond(current.id, true)}
            className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium hover:bg-indigo-500"
          >
            Approve <span className="text-indigo-200">A</span>
          </button>
          <button
            type="button"
            onClick={() => onRespond(current.id, false)}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Deny <span className="text-zinc-500">D</span>
          </button>
        </div>
      </div>
      {showArgs && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-950/70 p-2 text-xs text-zinc-400">
          {JSON.stringify(current.args, null, 2)}
        </pre>
      )}
    </div>
  );
}
