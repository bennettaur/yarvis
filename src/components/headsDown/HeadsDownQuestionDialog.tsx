import { useCallback, useEffect, useRef, useState } from "react";
import { type AttentionItem, headsDownQuestionId } from "../../lib/attention";
import {
  HEADS_DOWN_CACHE_PREFIX,
  type HeadsDownQuestion,
  listOpenQuestions,
  setToolAllowed,
} from "../../lib/headsDown";
import { invalidatePrefix } from "../../lib/resourceCache";
import LoadingIndicator from "../LoadingIndicator";
import QuestionCard from "./QuestionCard";

/** How long each question ignores clicks after it is shown, so a double click can't approve the next. */
export const HEADS_DOWN_ARMING_MS = 400;

/**
 * Answers heads-down mode's questions and approvals without leaving the
 * current page. Opened from a heads-down item in the attention panel. It starts
 * with that item's question, then walks through every other open one, and
 * calls `onDone` once none are left.
 */
export default function HeadsDownQuestionDialog({
  item,
  onClose,
  onDone = onClose,
  onOpenPage,
  armingMs = HEADS_DOWN_ARMING_MS,
}: {
  /** The attention row that was opened; null keeps the dialog closed. */
  item: AttentionItem | null;
  onClose: () => void;
  /** Called instead of `onClose` once every open question is answered or dismissed. */
  onDone?: () => void;
  /** Opens the Heads down page, for a question that needs more context. */
  onOpenPage: () => void;
  armingMs?: number;
}) {
  const [questions, setQuestions] = useState<HeadsDownQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const firstId = item ? headsDownQuestionId(item) : null;
  // Only the newest load may land, and none after the dialog closes or moves to another item.
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const open = await listOpenQuestions();
      if (seq !== loadSeq.current) return null;
      // The one the user clicked goes first; the rest go oldest first.
      const oldestFirst = [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const ordered = [
        ...oldestFirst.filter((q) => q.id === firstId),
        ...oldestFirst.filter((q) => q.id !== firstId),
      ];
      setQuestions(ordered);
      setError(null);
      return ordered;
    } catch (e) {
      if (seq === loadSeq.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [firstId]);

  useEffect(() => {
    setQuestions(null);
    setError(null);
    if (item) void load();
    return () => {
      loadSeq.current++;
    };
  }, [item, load]);

  const currentId = questions?.[0]?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-arm per question
  useEffect(() => {
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), armingMs);
    return () => clearTimeout(timer);
  }, [currentId]);

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

  const current = questions?.[0];

  const showNextQuestion = async () => {
    const seq = loadSeq.current;
    invalidatePrefix(HEADS_DOWN_CACHE_PREFIX);
    const remaining = await load();
    // Closed or moved on while the reload ran.
    if (loadSeq.current !== seq + 1) return;
    if (remaining === null) {
      // The reload failed: at least stop offering the question just answered.
      setQuestions((prev) => prev?.slice(1) ?? null);
      return;
    }
    if (remaining.length === 0) onDone();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close heads-down question"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={item.title}
        className="relative flex max-h-[85vh] w-[560px] max-w-full flex-col rounded-lg border border-zinc-800 bg-zinc-900 shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="truncate text-sm font-medium text-zinc-200">Heads down</div>
          <div className="flex shrink-0 items-center gap-2">
            {questions && questions.length > 1 && (
              <span className="text-[11px] text-zinc-500">{questions.length} waiting</span>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {error && (
            <p role="alert" className="mb-3 text-xs text-red-400">
              {error}
            </p>
          )}
          {!questions && !error && <LoadingIndicator className="text-xs text-zinc-500" />}
          {questions && !current && (
            <p className="text-xs text-zinc-500">Heads-down mode isn't waiting on you any more.</p>
          )}
          {current && (
            // Inert until armed, so a click aimed at the last prompt can't answer this one.
            <div inert={!armed} aria-busy={!armed}>
              <QuestionCard
                // A fresh card per question, so a typed answer never carries over.
                key={current.id}
                question={current}
                onAnswered={() => void showNextQuestion()}
                onAllowTool={async (toolId) => {
                  await setToolAllowed(toolId, true);
                }}
              />
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center border-t border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={onOpenPage}
            className="text-xs text-zinc-400 hover:text-zinc-100"
          >
            Open Heads down
          </button>
        </footer>
      </div>
    </div>
  );
}
