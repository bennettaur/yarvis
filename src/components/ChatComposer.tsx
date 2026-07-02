import { useEffect, useRef } from "react";

/** Tallest the textarea grows before it starts scrolling internally (px). */
const DEFAULT_MAX_HEIGHT = 160;

/**
 * Message composer shared by the chat and Omni builder. A multi-line textarea
 * that auto-grows with its content up to a cap; Enter submits and Shift+Enter
 * inserts a newline, so longer prompts are easy to write. The caller owns the
 * input value and supplies the submit action and labels.
 */
export default function ChatComposer({
  value,
  onChange,
  onSubmit,
  busy = false,
  placeholder,
  submitLabel,
  className = "flex gap-2",
  textareaClassName = "",
  maxHeight = DEFAULT_MAX_HEIGHT,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
  submitLabel: string;
  className?: string;
  /**
   * Extra classes for the textarea, e.g. a `min-h-*` to start taller. A
   * min-height also floors the auto-grow so the box never collapses below it.
   */
  textareaClassName?: string;
  /** Tallest the textarea grows before it scrolls internally (px). */
  maxHeight?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Re-measure after each value change. scrollHeight excludes the border so
  // it's added back under border-box; past the cap the textarea scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const style = window.getComputedStyle(el);
    const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(el.scrollHeight + borderY, maxHeight)}px`;
  }, [value, maxHeight]);

  return (
    <div className={className}>
      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className={`flex-1 resize-none overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50 ${textareaClassName}`}
      />
      <button
        onClick={onSubmit}
        disabled={busy}
        className="h-fit self-end rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? "…" : submitLabel}
      </button>
    </div>
  );
}
