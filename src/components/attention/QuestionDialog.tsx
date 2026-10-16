import { useEffect, useState } from "react";
import type { AttentionItem } from "../../lib/attention";
import { type DisplayError, formatError } from "../../lib/errors";
import {
  type AgentQuestion,
  answerQuestion,
  declineQuestion,
  type QuestionAnswer,
  type QuestionItem,
  questionsForItem,
} from "../../lib/questions";
import ErrorNotice from "../ErrorNotice";
import LoadingIndicator from "../LoadingIndicator";

/**
 * Answers a coding agent's `ask_user` questions without leaving the current
 * page. Opened from a `question` row in the attention panel; it loads every
 * question set the row's session has waiting and walks through them in the
 * order they were asked. Each reply goes straight back to the blocked agent.
 */

interface Draft {
  selected: string[];
  text: string;
}

const emptyDrafts = (set: AgentQuestion): Draft[] =>
  set.questions.map(() => ({ selected: [], text: "" }));

const isAnswered = (draft: Draft) => draft.selected.length > 0 || draft.text.trim() !== "";

function toAnswers(drafts: Draft[]): QuestionAnswer[] {
  return drafts.map((d) => ({
    selected: d.selected,
    ...(d.text.trim() ? { text: d.text.trim() } : {}),
  }));
}

function QuestionField({
  index,
  question,
  draft,
  onChange,
}: {
  index: number;
  question: QuestionItem;
  draft: Draft;
  onChange: (draft: Draft) => void;
}) {
  const options = question.options ?? [];
  const toggle = (label: string) => {
    const on = draft.selected.includes(label);
    const selected = question.multiSelect
      ? on
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label]
      : on
        ? []
        : [label];
    onChange({ ...draft, selected });
  };

  return (
    <fieldset className="space-y-2">
      {question.header && (
        <span className="inline-block rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">
          {question.header}
        </span>
      )}
      <legend className="sr-only">Question {index + 1}</legend>
      <p className="whitespace-pre-wrap text-sm text-zinc-100">{question.question}</p>
      {options.length > 0 && (
        <div className="space-y-1.5">
          {options.map((option) => {
            const on = draft.selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(option.label)}
                className={`block w-full rounded-md border px-3 py-2 text-left ${
                  on
                    ? "border-sky-500 bg-sky-950/40"
                    : "border-zinc-700 bg-zinc-900 hover:border-zinc-500"
                }`}
              >
                <span className="block text-sm text-zinc-100">{option.label}</span>
                {option.description && (
                  <span className="block text-xs text-zinc-400">{option.description}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <textarea
        value={draft.text}
        onChange={(e) => onChange({ ...draft, text: e.target.value })}
        rows={options.length > 0 ? 2 : 3}
        placeholder={options.length > 0 ? "Add a note (optional)" : "Your answer"}
        aria-label={options.length > 0 ? `Note for question ${index + 1}` : `Answer ${index + 1}`}
        className="w-full resize-y rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
      />
    </fieldset>
  );
}

export default function QuestionDialog({
  item,
  onClose,
  onOpenSession,
}: {
  /** The attention row that was opened; null keeps the dialog closed. */
  item: AttentionItem | null;
  onClose: () => void;
  /** Jumps to the asking session, for a question that needs more than a reply. */
  onOpenSession: (item: AttentionItem) => void;
}) {
  const [sets, setSets] = useState<AgentQuestion[] | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<DisplayError | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setSets(null);
    setError(null);
    questionsForItem(item)
      .then((loaded) => {
        if (cancelled) return;
        setSets(loaded);
        setDrafts(loaded[0] ? emptyDrafts(loaded[0]) : []);
      })
      .catch((e) => {
        if (!cancelled) setError(formatError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, onClose]);

  if (!item) return null;

  const current = sets?.[0];

  /** Sends the reply, then moves to the session's next question set or closes. */
  const reply = async (send: (id: string) => Promise<void>) => {
    if (!current || !sets) return;
    setSending(true);
    setError(null);
    try {
      await send(current.id);
      const rest = sets.slice(1);
      if (rest.length === 0) {
        onClose();
        return;
      }
      setSets(rest);
      setDrafts(emptyDrafts(rest[0]!));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setSending(false);
    }
  };

  const complete = drafts.length > 0 && drafts.every(isAnswered);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close question"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Question from ${item.title}`}
        className="relative flex max-h-[85vh] w-[560px] max-w-full flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-zinc-200">{item.title}</div>
            {current && <div className="mt-0.5 text-xs text-zinc-400">{current.context.task}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {sets && sets.length > 1 && (
              <span className="text-[11px] text-zinc-500">{sets.length} waiting</span>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-zinc-500 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {current?.context.reason && (
            <p className="whitespace-pre-wrap text-xs text-zinc-400">{current.context.reason}</p>
          )}
          {error && <ErrorNotice error={error} onDismiss={() => setError(null)} />}
          {!sets && !error && <LoadingIndicator className="text-xs text-zinc-500" />}
          {sets && !current && (
            <p className="text-xs text-zinc-500">This question has already been answered.</p>
          )}
          {current?.questions.map((question, i) => (
            <QuestionField
              // Questions in a set are fixed once asked, so the index is stable.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={i}
              index={i}
              question={question}
              draft={drafts[i] ?? { selected: [], text: "" }}
              onChange={(draft) => setDrafts((prev) => prev.map((d, j) => (j === i ? draft : d)))}
            />
          ))}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenSession(item)}
            className="text-xs text-zinc-400 hover:text-zinc-100"
          >
            Go to session
          </button>
          {current && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={sending}
                onClick={() => void reply(declineQuestion)}
                title="Tell the agent you won't answer, so it carries on without you"
                className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-100 disabled:opacity-50"
              >
                Skip
              </button>
              <button
                type="button"
                disabled={sending || !complete}
                onClick={() => void reply((id) => answerQuestion(id, toAnswers(drafts)))}
                className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50"
              >
                Send answers
              </button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
