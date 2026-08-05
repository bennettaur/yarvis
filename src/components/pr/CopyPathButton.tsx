import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../../lib/clipboard";

/** How long the tick (or the failure mark) stays up before the icon resets. */
const FEEDBACK_MS = 1500;

type Result = "idle" | "copied" | "failed";

/**
 * Copies a changed file's repo-relative path to the system clipboard — the
 * thing a reader reaches for when they want to open the file in an editor or
 * quote it to an agent. It lives next to the filename in both the file list and
 * the diff header, so it is reachable from wherever the reader happens to be.
 *
 * Both hosts wrap it in something that reacts to clicks of its own (a
 * `<summary>` that folds the file, a row that scrolls the diff into view), so
 * the click is stopped here rather than at each call site.
 */
export default function CopyPathButton({
  path,
  className = "",
}: {
  path: string;
  /** Extra classes from the host, e.g. hover-reveal in a dense list row. */
  className?: string;
}) {
  const [result, setResult] = useState<Result>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await writeClipboard(path);
      setResult("copied");
    } catch (err) {
      console.error("[pr] copying the file path failed:", err);
      setResult("failed");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setResult("idle"), FEEDBACK_MS);
  };

  const label =
    result === "copied" ? "Path copied" : result === "failed" ? "Copying failed" : "Copy path";

  return (
    <button
      type="button"
      onClick={copy}
      title={result === "idle" ? `Copy path: ${path}` : label}
      aria-label={`Copy path ${path}`}
      className={`shrink-0 rounded p-0.5 transition-colors ${
        result === "copied"
          ? "text-emerald-400"
          : result === "failed"
            ? "text-red-400"
            : "text-zinc-500 hover:text-zinc-200"
      } ${className}`}
    >
      {result === "copied" ? <CheckIcon /> : <CopyIcon />}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.75 10.25h-.5a1.5 1.5 0 0 1-1.5-1.5v-5.5a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v.5" />
      <rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5l3 3 6-6" />
    </svg>
  );
}
