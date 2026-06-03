import { useEffect, useRef } from "react";

/** Tallest the textarea grows before it starts scrolling internally (px). */
const MAX_HEIGHT = 160;

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
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  placeholder?: string;
  submitLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resize to fit the content (reset to auto first so it can also shrink, e.g.
  // after the value is cleared on submit). scrollHeight excludes the border, so
  // add it back under border-box sizing to avoid a hairline scrollbar; past the
  // cap the textarea scrolls internally.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    const style = window.getComputedStyle(el);
    const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(el.scrollHeight + borderY, MAX_HEIGHT)}px`;
  }, []);

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
        className="flex-1 resize-none overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
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
