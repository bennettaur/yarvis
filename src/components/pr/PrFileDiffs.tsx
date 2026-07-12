import { useEffect, useMemo, useRef, useState } from "react";
import { postPrComment } from "../../lib/pr/api";
import {
  invalidate,
  prDetailKey,
  usePrDetail,
  usePrFileDiff,
  usePrFiles,
} from "../../lib/pr/cache";
import { parsePatch } from "../../lib/pr/diff";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { rowClass } from "../diff/DiffView";
import { ThreadCard } from "./PrDescription";
import { prFileAnchorId } from "./shared";

/** Files whose diffs are fetched eagerly so the top of the view is populated. */
const PREFETCH_COUNT = 4;

/** Inline composer for a new line comment. */
function CommentComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The composer only mounts when the user clicks a line's "+", so focusing it
  // is expected. Done via a ref rather than the autoFocus attribute (which
  // fires on initial page render and is an accessibility anti-pattern there).
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="border-l-2 border-sky-700 bg-zinc-900 p-2">
      <textarea
        ref={textareaRef}
        value={body}
        placeholder="Leave a comment…"
        onChange={(e) => setBody(e.target.value)}
        className="h-20 w-full rounded-md border border-zinc-700 bg-zinc-800 p-2 text-sm text-zinc-100"
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !body.trim()}
          className="rounded-md bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {busy ? "Posting…" : "Comment"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Groups a file's review threads by their right-side line number. */
function threadsByLine(threads: ReviewThread[]): Map<number, ReviewThread[]> {
  const map = new Map<number, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.line == null) continue;
    const list = map.get(thread.line);
    if (list) list.push(thread);
    else map.set(thread.line, [thread]);
  }
  return map;
}

export function DiffBody({
  prRef,
  file,
  patch,
  threads,
}: {
  prRef: PrRef;
  file: PrFile;
  patch: string;
  threads: ReviewThread[];
}) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const byLine = useMemo(() => threadsByLine(threads), [threads]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  // Comments posted this session, shown immediately while the server catches up.
  const [pending, setPending] = useState<{ line: number; body: string }[]>([]);

  const submit = async (line: number, body: string) => {
    await postPrComment(prRef, { path: file.filename, line, body });
    setPending((p) => [...p, { line, body }]);
    setActiveLine(null);
    // Drop the cached detail so the real thread replaces the optimistic one on
    // the next load of this PR.
    invalidate(prDetailKey(prRef));
  };

  return (
    <div className="overflow-x-auto rounded-b-lg bg-zinc-950 font-mono text-xs leading-relaxed">
      {rows.map((row, i) => {
        const commentable = row.rightLine != null;
        const lineThreads = row.rightLine != null ? byLine.get(row.rightLine) : undefined;
        const linePending =
          row.rightLine != null ? pending.filter((p) => p.line === row.rightLine) : [];
        return (
          <div key={i}>
            <div className={`group flex ${rowClass(row.kind)}`}>
              <span className="flex w-12 shrink-0 select-none items-center justify-end gap-1 pr-2 text-zinc-600">
                {commentable && (
                  <button
                    type="button"
                    onClick={() => setActiveLine(row.rightLine)}
                    title="Comment on this line"
                    className="opacity-0 group-hover:opacity-100 text-sky-400 hover:text-sky-300"
                  >
                    +
                  </button>
                )}
                <span>{row.rightLine ?? ""}</span>
              </span>
              <span className="whitespace-pre">{row.text || " "}</span>
            </div>
            {(lineThreads ||
              linePending.length > 0 ||
              (commentable && activeLine === row.rightLine)) && (
              <div className="space-y-2 px-3 py-2 font-sans">
                {lineThreads?.map((t, j) => (
                  <ThreadCard key={`t-${j}`} thread={t} />
                ))}
                {linePending.map((p, j) => (
                  <div
                    key={`p-${j}`}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-300"
                  >
                    <div className="mb-1 text-xs font-medium text-zinc-500">you · just now</div>
                    {p.body}
                  </div>
                ))}
                {commentable && activeLine === row.rightLine && (
                  <CommentComposer
                    onSubmit={(body) => submit(row.rightLine as number, body)}
                    onCancel={() => setActiveLine(null)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The pill-shaped "Viewed" toggle in a file's title bar. Filled emerald when
 * the file is marked viewed, outlined when not. Click stops propagation so the
 * surrounding `<summary>` doesn't also toggle the diff's open state — the
 * parent does that explicitly so collapse-on-view stays under our control.
 */
function ViewedToggle({ isViewed, onClick }: { isViewed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      title={isViewed ? "Mark unviewed" : "Mark viewed"}
      className={`ml-auto flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
        isViewed
          ? "border-emerald-600 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      }`}
    >
      <span
        aria-hidden="true"
        className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border ${
          isViewed ? "border-emerald-400 bg-emerald-500/30" : "border-zinc-600"
        }`}
      >
        {isViewed && (
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none">
            <path
              d="M3.5 8.5l3 3 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      Viewed
    </button>
  );
}

function FileDiff({
  prRef,
  file,
  index,
  threads,
  isViewed,
  onToggleViewed,
}: {
  prRef: PrRef;
  file: PrFile;
  index: number;
  threads: ReviewThread[];
  isViewed: boolean;
  onToggleViewed: (path: string) => void;
}) {
  // The first few unviewed files are open on mount; viewed files start
  // collapsed regardless so the user's prior progress stays out of the way.
  // The rest load when expanded, so a large Azure PR doesn't fetch every
  // file's content up front. Marking viewed later also collapses the diff and
  // unmarking re-expands it (see `toggleViewed` below).
  const [open, setOpen] = useState(!isViewed && index < PREFETCH_COUNT);
  const { data: loaded, loading } = usePrFileDiff(prRef, file, open);
  const patch = loaded?.patch ?? file.patch;
  const fileThreads = useMemo(
    () => threads.filter((t) => t.path === file.filename),
    [threads, file.filename],
  );

  // Single handler so the visual collapse and the underlying viewed mutation
  // happen together — the diff folds away exactly when the user marks it done
  // and pops back open if they undo. Keeping them coupled here avoids a flash
  // where the diff is still expanded under a "Viewed" pill (or vice versa).
  const toggleViewed = () => {
    setOpen(isViewed);
    onToggleViewed(file.filename);
  };

  return (
    <details
      id={prFileAnchorId(prRef, index)}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className={`scroll-mt-4 rounded-lg border border-zinc-800 ${isViewed ? "opacity-70" : ""}`}
    >
      {/* The header sticks to the top of the scrolling review body while its
          diff is in view, so the filename and the Viewed toggle stay reachable
          all the way to the end of a long file. It stops sticking once the
          file's own box scrolls past — the next file's header takes over.
          `overflow-hidden` is deliberately absent from the `<details>`: a
          clipping ancestor would confine the sticky header to that box and
          break the effect, so the corners are rounded on the header/body
          directly instead. */}
      <summary
        className={`sticky top-0 z-10 flex cursor-pointer items-center gap-2 bg-zinc-900 px-3 py-2 text-sm ${
          open ? "rounded-t-lg" : "rounded-lg"
        }`}
      >
        <span
          className={`min-w-0 truncate font-mono ${
            isViewed ? "text-zinc-500 line-through" : "text-zinc-200"
          }`}
        >
          {file.filename}
        </span>
        {file.additions + file.deletions > 0 && (
          <>
            <span className="text-xs text-emerald-400">+{file.additions}</span>
            <span className="text-xs text-red-400">−{file.deletions}</span>
          </>
        )}
        {file.status !== "modified" && <span className="text-xs text-zinc-500">{file.status}</span>}
        <ViewedToggle isViewed={isViewed} onClick={toggleViewed} />
      </summary>
      {open &&
        (loading && !patch ? (
          <p className="px-3 py-2 text-xs text-zinc-600">Loading diff…</p>
        ) : patch ? (
          <DiffBody prRef={prRef} file={loaded ?? file} patch={patch} threads={fileThreads} />
        ) : (
          <p className="px-3 py-2 text-xs text-zinc-600">No textual diff (binary or too large).</p>
        ))}
    </details>
  );
}

/** The changed files of a PR rendered as expandable, comment-able unified diffs. */
export default function PrFileDiffs({
  prRef,
  viewed,
  onToggleViewed,
}: {
  prRef: PrRef;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
}) {
  const { data, error, loading } = usePrFiles(prRef);
  const detail = usePrDetail(prRef);
  const threads = detail.data?.reviewThreads ?? [];

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading diff…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  return (
    <div className="space-y-2">
      {data.map((f, i) => (
        <FileDiff
          key={f.filename}
          prRef={prRef}
          file={f}
          index={i}
          threads={threads}
          isViewed={viewed.has(f.filename)}
          onToggleViewed={onToggleViewed}
        />
      ))}
    </div>
  );
}
