import { useMemo, useState } from "react";
import { usePrFiles } from "../../lib/pr/cache";
import type { PrRef } from "../../lib/pr/types";
import { prFileAnchorId } from "./shared";

const STATUS_LETTER: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "text-emerald-400" },
  removed: { letter: "D", color: "text-red-400" },
  modified: { letter: "M", color: "text-amber-400" },
  renamed: { letter: "R", color: "text-sky-400" },
};

/**
 * Compact list of a PR's changed files. Clicking an entry scrolls the matching
 * `PrFileDiffs` entry into view (by shared anchor id, so it works whether the
 * diffs sit beside it or elsewhere on the page) and notifies `onSelect`. A
 * per-row checkbox marks the file as viewed; clicks on the checkbox don't
 * trigger the scroll so toggling never moves focus away.
 */
export default function PrFileList({
  prRef,
  onSelect,
  viewed,
  onToggleViewed,
}: {
  prRef: PrRef;
  onSelect?: (index: number) => void;
  /** Paths the viewer has marked viewed. */
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
}) {
  const { data, error, loading } = usePrFiles(prRef);
  const [selected, setSelected] = useState<number | null>(null);

  // Hoisted above the early returns to keep hook order stable.
  const viewedCount = useMemo(
    () => (data ? data.filter((f) => viewed.has(f.filename)).length : 0),
    [data, viewed],
  );

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading files…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  const onClick = (index: number) => {
    setSelected(index);
    onSelect?.(index);
    document
      .getElementById(prFileAnchorId(prRef, index))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      <div className="mb-1 px-2 text-xs text-zinc-500">
        {viewedCount}/{data.length} viewed
      </div>
      <ul className="space-y-0.5 text-sm">
        {data.map((f, i) => {
          const status = STATUS_LETTER[f.status] ?? { letter: "•", color: "text-zinc-500" };
          const isViewed = viewed.has(f.filename);
          return (
            <li key={f.filename}>
              <div
                className={`flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800 ${
                  selected === i ? "bg-zinc-800" : ""
                } ${isViewed ? "opacity-60" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={isViewed}
                  onChange={(e) => {
                    // Toggling viewed shouldn't scroll the diff into view —
                    // stop the click from bubbling to the row button below.
                    e.stopPropagation();
                    onToggleViewed(f.filename);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 shrink-0 accent-emerald-500"
                  title={isViewed ? "Mark unviewed" : "Mark viewed"}
                  aria-label={`Mark ${f.filename} ${isViewed ? "unviewed" : "viewed"}`}
                />
                <button
                  type="button"
                  onClick={() => onClick(i)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={f.filename}
                >
                  <span className={`${status.color} shrink-0 font-mono text-xs`}>
                    {status.letter}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate font-mono text-xs ${
                      isViewed ? "text-zinc-500 line-through" : "text-zinc-300"
                    }`}
                  >
                    {f.filename}
                  </span>
                  {f.additions + f.deletions > 0 && (
                    <>
                      <span className="shrink-0 text-xs text-emerald-400">+{f.additions}</span>
                      <span className="shrink-0 text-xs text-red-400">−{f.deletions}</span>
                    </>
                  )}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
