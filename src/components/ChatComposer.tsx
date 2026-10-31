import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef } from "react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "./ai-elements/prompt-input";

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
  onStop,
  tools,
  className = "",
  textareaClassName = "",
  maxHeight = DEFAULT_MAX_HEIGHT,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy?: boolean;
  /**
   * Ends the turn in flight. Present on surfaces that can cancel; the send
   * button becomes Stop while busy, so a turn the user no longer wants doesn't
   * have to be waited out.
   */
  onStop?: () => void;
  placeholder?: string;
  submitLabel: string;
  /** Controls for the toolbar under the textarea, such as the model picker. */
  tools?: ReactNode;
  /** Extra classes for the wrapper, e.g. padding or a divider from what sits above. */
  className?: string;
  /**
   * Extra classes for the textarea, e.g. a `min-h-*` to start taller. A
   * min-height also floors the auto-grow so the box never collapses below it.
   */
  textareaClassName?: string;
  /** Tallest the textarea grows before it scrolls internally (px). */
  maxHeight?: number;
  /** The textarea, for a host that moves focus into it. */
  inputRef?: Ref<HTMLTextAreaElement | null>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle<HTMLTextAreaElement | null, HTMLTextAreaElement | null>(
    inputRef,
    () => ref.current,
    [],
  );

  // Re-measure after each value change. scrollHeight excludes the border so
  // it's added back under border-box; past the cap the textarea scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure on every value change
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // Under `display: none` (the Chat tab mounts behind whichever tab is open)
    // there is no layout, so scrollHeight is 0. Pinning that would leave the
    // box at its padding's height once shown; left at auto, it shows one row.
    if (el.scrollHeight === 0) return;
    const style = window.getComputedStyle(el);
    const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = `${Math.min(el.scrollHeight + borderY, maxHeight)}px`;
  }, [value, maxHeight]);

  return (
    <div className={className}>
      <PromptInput>
        <PromptInputTextarea
          ref={ref}
          rows={1}
          value={value}
          placeholder={placeholder}
          title="Enter sends, Shift+Enter inserts a newline."
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          className={textareaClassName}
        />
        <PromptInputFooter>
          <PromptInputTools>{tools}</PromptInputTools>
          {busy && onStop ? (
            <PromptInputSubmit
              status="streaming"
              variant="outline"
              onClick={onStop}
              title="Cancel the reply in progress."
            >
              Stop
            </PromptInputSubmit>
          ) : (
            <PromptInputSubmit
              status={busy ? "submitted" : "ready"}
              onClick={onSubmit}
              disabled={busy}
            >
              {submitLabel}
            </PromptInputSubmit>
          )}
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
