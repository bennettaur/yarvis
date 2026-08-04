import { useEffect, useRef, useState } from "react";
import type { PrInsight } from "../../lib/pr/insights";
import Markdown from "../Markdown";
import type { InsightsController } from "./usePrInsights";

/**
 * Insights rendered in the diff: the reviewer's own answers, pinned to the
 * lines they were asked about, plus the composer for a new question.
 *
 * Styled apart from review threads on purpose. A thread is something the author
 * will see; an insight is a private note until the reviewer posts it, and the
 * two would be dangerous to confuse.
 */

/** The insights anchored to a given line — the last line of their range. */
export function insightsAtLine(
  insights: PrInsight[] | undefined,
  line: number | null,
): PrInsight[] {
  if (!insights || line == null) return [];
  return insights.filter((i) => i.endLine === line);
}

function InsightCard({
  insight,
  controller,
  currentSha,
}: {
  insight: PrInsight;
  controller: InsightsController;
  /** The PR's head; empty when it isn't known. */
  currentSha: string;
}) {
  const stale = currentSha !== "" && insight.headSha !== currentSha;
  return (
    <div className="rounded-lg border border-violet-900 bg-violet-950/20 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span className="font-medium text-violet-300">Insight</span>
        {stale && (
          <span
            title={`Answered against ${insight.headSha.slice(0, 7)}; the pull request has moved since.`}
            className="rounded border border-amber-700 px-1.5 py-0.5 text-amber-300"
          >
            Out of date
          </span>
        )}
        {insight.postedAt ? (
          <span className="ml-auto text-emerald-400">Posted to the PR</span>
        ) : (
          <button
            type="button"
            onClick={() => void controller.post(insight.id)}
            title="Post this as a comment on the pull request"
            className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Post
          </button>
        )}
        <button
          type="button"
          onClick={() => void controller.remove(insight.id)}
          title="Delete this insight"
          aria-label="Delete this insight"
          className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      <p className="mb-2 text-xs italic text-zinc-400">{insight.question}</p>
      <div className="text-zinc-200">
        <Markdown>{insight.answer}</Markdown>
      </div>
    </div>
  );
}

/** Composer for a question about the lines it is anchored under. */
function AskComposer({ controller }: { controller: InsightsController }) {
  const [question, setQuestion] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Mounted only when the reviewer opens it, so focusing is expected. Via a ref
  // rather than autoFocus, which fires on first page render too.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => void controller.submit(question);

  return (
    <div className="rounded-lg border border-violet-800 bg-zinc-900 p-2">
      <textarea
        ref={textareaRef}
        value={question}
        placeholder="Ask about these lines — what calls this, why is it here, what would break…"
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; the questions are one-liners and reaching for the
          // button each time would slow down a reader mid-review.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={controller.pending}
        className="h-16 w-full rounded-md border border-zinc-700 bg-zinc-800 p-2 text-sm text-zinc-100 disabled:opacity-60"
      />
      {controller.error && <p className="mt-1 text-xs text-red-400">{controller.error}</p>}
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={controller.pending || !question.trim()}
          className="rounded-md bg-violet-700 px-3 py-1 text-xs text-white hover:bg-violet-600 disabled:opacity-50"
        >
          {controller.pending ? "Looking…" : "Ask"}
        </button>
        <button
          type="button"
          onClick={controller.closeAsk}
          disabled={controller.pending}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
        >
          Cancel
        </button>
        {controller.pending && (
          <span className="text-xs text-zinc-500">Reading the code around this…</span>
        )}
      </div>
    </div>
  );
}

/**
 * Whether a line has anything hanging below it. Exported so the grid-based
 * side-by-side view can skip emitting a wrapper for the vast majority of lines
 * that have neither an insight nor an open composer.
 */
export function hasInsightsAt(
  controller: InsightsController,
  path: string,
  line: number | null,
): boolean {
  if (line == null) return false;
  if (insightsAtLine(controller.byPath.get(path), line).length > 0) return true;
  return controller.asking?.path === path && controller.asking.endLine === line;
}

/**
 * Everything hanging below one line: its insights, and the composer when open
 * against it. Renders nothing otherwise, so an empty container's padding never
 * shows up as a gap between diff rows.
 */
export default function InsightBlock({
  path,
  line,
  controller,
  currentSha,
}: {
  path: string;
  line: number | null;
  controller: InsightsController;
  currentSha: string;
}) {
  if (!hasInsightsAt(controller, path, line)) return null;
  const cards = insightsAtLine(controller.byPath.get(path), line);
  const composing = controller.asking?.path === path && controller.asking.endLine === line;

  return (
    <div className="space-y-2 px-3 py-2 font-sans">
      {cards.map((insight) => (
        <InsightCard
          key={insight.id}
          insight={insight}
          controller={controller}
          currentSha={currentSha}
        />
      ))}
      {composing && <AskComposer controller={controller} />}
    </div>
  );
}
