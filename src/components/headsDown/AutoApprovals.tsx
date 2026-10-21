import { useState } from "react";
import type { HeadsDownQuestion } from "../../lib/headsDown";

/**
 * Calls the decision model approved on the user's behalf: each tool, when, why,
 * and with what arguments. This is the oversight for auto mode, so it stays on
 * the page rather than in a log.
 */
export default function AutoApprovals({ approvals }: { approvals: HeadsDownQuestion[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (approvals.length === 0) return null;
  return (
    <ul className="space-y-1">
      {approvals.map((approval) => {
        const isOpen = openId === approval.id;
        return (
          <li
            key={approval.id}
            className="rounded-md border border-zinc-800 bg-zinc-900/40 text-xs"
          >
            <button
              type="button"
              onClick={() => setOpenId(isOpen ? null : approval.id)}
              aria-expanded={isOpen}
              className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left"
            >
              <span className="min-w-0">
                <span className="font-mono text-zinc-200">{approval.action}</span>
                {approval.answer && <span className="block text-zinc-400">{approval.answer}</span>}
              </span>
              <span className="shrink-0 text-zinc-500">
                {approval.answeredAt ? new Date(approval.answeredAt).toLocaleString() : null}
              </span>
            </button>
            {isOpen && (
              <pre className="max-h-48 overflow-auto border-t border-zinc-800 p-2 text-zinc-300">
                {JSON.stringify(approval.toolArgs, null, 2)}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
