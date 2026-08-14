import { useEffect, useRef, useState } from "react";
import { clipboardSafePath, writeClipboard } from "../../lib/clipboard";

/** How long the tick (or the failure mark) stays up before the icon resets. */
export const FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const LABELS: Record<CopyState, string> = {
  idle: "Copy path",
  copied: "Path copied",
  failed: "Copying failed",
};

/**
 * Copies a changed file's repo-relative path to the system clipboard — the
 * thing a reader reaches for when they want to open the file in an editor or
 * quote it to an agent. It lives next to the filename in both the file list and
 * the diff header, so it is reachable from wherever the reader happens to be.
 *
 * The diff header is a `<summary>`, so a click here would otherwise fold the
 * file away. The file list row carries no handler of its own today — the
 * scroll-to-file one sits on a sibling button — but the click is stopped for
 * both hosts so a future row-level handler can't hijack a copy.
 */
export default function CopyPathButton({
  path,
  className = "",
}: {
  path: string;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      await writeClipboard(clipboardSafePath(path));
      setCopyState("copied");
    } catch (e) {
      console.error("[pr] copying the file path failed:", e);
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
        title={copyState === "idle" ? `Copy path ${path}` : LABELS[copyState]}
        aria-label={`Copy path ${path}`}
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
        {copyState === "idle" ? "" : LABELS[copyState]}
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
