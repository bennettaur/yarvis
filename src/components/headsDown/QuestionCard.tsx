import { useState } from "react";
import { answerQuestion, dismissQuestion, type HeadsDownQuestion } from "../../lib/headsDown";

/**
 * One thing heads-down mode is waiting on the user for. A question offers the
 * options the loop gave plus a free-text answer; an approval shows the exact
 * call it would make, since approving lets that call, and only that one, run.
 */
export default function QuestionCard({
  question,
  onAnswered,
  onAllowTool,
}: {
  question: HeadsDownQuestion;
  onAnswered: () => void;
  /**
   * Lets the loop call this MCP tool without asking from now on, and approves
   * this call. Offered only for an MCP tool's approval.
   */
  onAllowTool?: (toolId: string) => Promise<void>;
}) {
  const [answerText, setAnswerText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (input: { choice?: string; answer?: string }) => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(question.id, input);
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      await dismissQuestion(question.id);
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isApproval = question.kind === "approval";
  const mcpTool = isApproval && question.action?.startsWith("mcp:") ? question.action : null;

  const allowTool = async () => {
    if (!mcpTool || !onAllowTool) return;
    setBusy(true);
    setError(null);
    try {
      await onAllowTool(mcpTool);
      await answerQuestion(question.id, { choice: "approve" });
      onAnswered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-amber-300">
        {isApproval ? "Approval" : "Question"}
      </div>
      <p className="whitespace-pre-wrap text-sm text-zinc-100">{question.question}</p>
      {question.situation && !isApproval && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">{question.situation}</p>
      )}
      {isApproval && question.toolArgs !== null && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-zinc-950 p-2 text-xs text-zinc-300">
          {JSON.stringify(question.toolArgs, null, 2)}
        </pre>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {isApproval ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send({ choice: "approve" })}
              className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
            >
              Approve this call
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send({ choice: "deny" })}
              className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              Deny
            </button>
            {mcpTool && onAllowTool && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void allowTool()}
                className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Always allow this tool in heads-down mode
              </button>
            )}
          </>
        ) : (
          question.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send({ choice: option })}
              className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {option}
            </button>
          ))
        )}
      </div>

      {!isApproval && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (answerText.trim()) void send({ answer: answerText.trim() });
          }}
        >
          <input
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="Or answer in your own words"
            aria-label="Answer"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !answerText.trim()}
            className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            Answer
          </button>
        </form>
      )}

      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss()}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          Dismiss
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
