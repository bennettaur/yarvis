import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../lib/clipboard";

/** How long the tick (or the failure mark) stays up before the icon resets. */
export const FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

/**
 * What the button says in each state. `subject` names the thing being copied
 * ("path", "PR link", "checks"), so the confirmation reads as a sentence about
 * it rather than a bare "Copied".
 */
function labelsFor(subject: string): Record<CopyState, string> {
  return {
    idle: `Copy ${subject}`,
    copied: `${subject.charAt(0).toUpperCase()}${subject.slice(1)} copied`,
    failed: "Copying failed",
  };
}

/**
 * Puts one piece of text — a path, a link, a summary line — on the system
 * clipboard, so anything on screen can be quoted into Slack or a prompt without
 * a trip through the browser. Confirms with a tick that resets itself, and
 * announces the same thing to a screen reader through a sibling live region.
 *
 * The click is stopped from bubbling and its default suppressed: these buttons
 * sit inside rows, `<summary>` headers and other clickable hosts, where a copy
 * that also folded a file away or navigated would be worse than no button.
 *
 * `value` is taken lazily when it is a function, for hosts that would otherwise
 * assemble a whole list on every render.
 */
export default function CopyButton({
  value,
  subject,
  title,
  className = "",
}: {
  value: string | (() => string);
  /** Noun phrase naming what gets copied, e.g. "path" or "PR link". */
  subject: string;
  /** Overrides the tooltip and accessible name, e.g. to include the value. */
  title?: string;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const labels = labelsFor(subject);
  const name = title ?? labels.idle;

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const copy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    // Belt and braces with the line above: in a real browser a `<summary>`'s
    // default activation is a separate concern from bubbling.
    event.preventDefault();
    try {
      await writeClipboard(typeof value === "function" ? value() : value);
      setCopyState("copied");
    } catch (e) {
      console.error(`[copy] copying the ${subject} failed:`, e);
      setCopyState("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), FEEDBACK_MS);
  };

  return (
    <>
      <button
        type="button"
        onClick={copy}
        title={copyState === "idle" ? name : labels[copyState]}
        aria-label={name}
        className={`shrink-0 rounded p-0.5 transition-colors ${
          copyState === "copied"
            ? "text-emerald-400"
            : copyState === "failed"
              ? "text-red-400"
              : "text-zinc-500 hover:text-zinc-200"
        } ${className}`}
      >
        {copyState === "copied" ? (
          <CheckIcon />
        ) : copyState === "failed" ? (
          <AlertIcon />
        ) : (
          <CopyIcon />
        )}
      </button>
      {/* A sibling, not a child: the `aria-label` above wins the button's
          accessible name outright, so a live region nested inside it would never
          be read. Empty while idle, so the reset doesn't announce a second time. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copyState === "idle" ? "" : labels[copyState]}
      </span>
    </>
  );
}

function CopyIcon() {
  return (
    <IconFrame>
      <path d="M3.75 10.25h-.5a1.5 1.5 0 0 1-1.5-1.5v-5.5a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v.5" />
      <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    </IconFrame>
  );
}

function CheckIcon() {
  return (
    <IconFrame strokeWidth="2">
      <path d="M3.5 8.5l3 3 6-6" />
    </IconFrame>
  );
}

/** Failure needs a shape of its own — a red tint alone conveys nothing. */
function AlertIcon() {
  return (
    <IconFrame>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75v3.75" />
      <path d="M8 11.25h.01" />
    </IconFrame>
  );
}

function IconFrame({
  children,
  strokeWidth = "1.5",
}: {
  children: React.ReactNode;
  strokeWidth?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
