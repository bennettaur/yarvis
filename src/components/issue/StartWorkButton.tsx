import type { MouseEvent } from "react";

/**
 * The row action that starts work on an issue straight from a list, without
 * opening it first. Uses the same play triangle as the task list's start-work
 * control so the two read as the same action.
 */
export default function StartWorkButton({
  busy,
  label,
  onStart,
}: {
  /** True from the click until the flow hands off (JIRA: until its picker closes). */
  busy: boolean;
  /** Accessible name; the surrounding row is a click target of its own. */
  label: string;
  onStart: (e: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={busy}
      aria-label={label}
      title="Start work"
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded hover:text-indigo-300 disabled:opacity-50 ${
        busy ? "animate-pulse text-indigo-300" : "text-zinc-600"
      }`}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <path d="M5 3.5v9l7-4.5-7-4.5Z" fill="currentColor" />
      </svg>
    </button>
  );
}
