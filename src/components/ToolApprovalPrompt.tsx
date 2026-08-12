import type { PendingApproval } from "../lib/chat";

/**
 * Inline approve/deny prompt for a pending MCP tool call. Rendered in the chat
 * thread while the agent's turn is paused awaiting the user's decision.
 */
export function ToolApprovalPrompt({
  approval,
  onRespond,
}: {
  approval: PendingApproval;
  onRespond: (approved: boolean) => void;
}) {
  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/30 p-3 text-sm">
      <div className="mb-1 text-xs uppercase tracking-wide text-amber-400">Tool approval</div>
      <div className="text-zinc-100">
        The agent wants to call <span className="font-medium">{approval.name}</span>
        {approval.server && (
          <>
            {" "}
            on <span className="font-medium">{approval.server}</span>
          </>
        )}
        .
      </div>
      {approval.args !== undefined && approval.args !== null && (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-300">
          {JSON.stringify(approval.args, null, 2)}
        </pre>
      )}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => onRespond(true)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
        >
          Approve
        </button>
        <button
          onClick={() => onRespond(false)}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
