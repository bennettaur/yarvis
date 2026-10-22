import type { QuestionItem } from "../../lib/questions";

/**
 * One question with its options and a free-text box. Shared by the dialog for
 * `ask_user` questions and the permission modal, which shows Claude Code's own
 * AskUserQuestion prompts the same way.
 */

export interface Draft {
  selected: string[];
  text: string;
}

export const EMPTY_DRAFT: Draft = { selected: [], text: "" };

export const emptyDrafts = (questions: QuestionItem[]): Draft[] => questions.map(() => EMPTY_DRAFT);

export const isAnswered = (draft: Draft) => draft.selected.length > 0 || draft.text.trim() !== "";

export function QuestionField({
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
    const isSelected = draft.selected.includes(label);
    let selected: string[];
    if (question.multiSelect) {
      selected = isSelected
        ? draft.selected.filter((l) => l !== label)
        : [...draft.selected, label];
    } else {
      selected = isSelected ? [] : [label];
    }
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
            const isSelected = draft.selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={isSelected}
                onClick={() => toggle(option.label)}
                className={`block w-full rounded-md border px-3 py-2 text-left ${
                  isSelected
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
