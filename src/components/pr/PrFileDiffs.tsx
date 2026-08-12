import { useEffect, useMemo, useRef, useState } from "react";
import { buildFileTree, flattenFileTree } from "../../lib/fileTree";
import { usePrDetail, usePrFileDiff, usePrFiles } from "../../lib/pr/cache";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { rowClass } from "../diff/DiffView";
import { usePersistedBoolean } from "../SplitPane";
import ChangeMinimap from "./ChangeMinimap";
import CopyPathButton from "./CopyPathButton";
import GapMarker from "./GapMarker";
import InsightBlock from "./InsightCards";
import {
  AddCommentButton,
  AskAboutLineButton,
  LineCommentBlock,
  useLineComments,
} from "./LineComments";
import SplitDiffBody from "./SplitDiffBody";
import { type DiffFocus, FOCUS_ATTR, FOCUS_STYLE, focusRange, prFileAnchorId } from "./shared";
import { useAskSelection } from "./useAskSelection";
import { useExpandOnApproach } from "./useExpandOnApproach";
import { type FileExpansion, useFileExpansion } from "./useFileExpansion";
import { type InsightsController, usePrInsights } from "./usePrInsights";

/**
 * Files whose diffs are open on mount. Scrolling opens the rest as they come
 * into reach (see {@link useExpandOnApproach}); this only covers the files
 * already on screen at first paint, so the top of the review doesn't flash
 * collapsed before the observer's first callback.
 */
const PREFETCH_COUNT = 4;

/** Remembers the unified/side-by-side choice across PRs and app restarts. */
const SPLIT_VIEW_KEY = "yarvis.pr.splitDiff";

/**
 * A fold/unfold request broadcast to every file at once. It carries an `epoch`
 * rather than being a plain boolean so pressing "Collapse all" a second time
 * still reaches files the reader has expanded by hand since the first press.
 */
interface FoldAll {
  open: boolean;
  epoch: number;
}

/** A file's diff as a single column of unified-diff rows. */
export function DiffBody({
  prRef,
  file,
  threads,
  expansion,
  highlight,
  insights,
  headSha = "",
}: {
  prRef: PrRef;
  file: PrFile;
  threads: ReviewThread[];
  expansion: FileExpansion;
  /** Lines a guided review is pointing at, marked down the left edge. */
  highlight?: { start: number; end: number } | null;
  /** Omitted where there is no review to ask questions in (Omni widgets). */
  insights?: InsightsController;
  headSha?: string;
}) {
  const comments = useLineComments(prRef, file, threads);
  const ask = useAskSelection(file.filename, expansion.rows, insights);

  return (
    <div className="relative overflow-x-auto rounded-b-lg bg-zinc-950 font-mono text-xs leading-relaxed">
      {expansion.rows.map((item, i) => {
        if (item.kind === "gap") {
          return (
            <GapMarker
              key={`gap-${item.gap.index}`}
              gap={item.gap}
              hidden={item.hidden}
              onExpand={expansion.expand}
              onExpandFully={expansion.expandFully}
            />
          );
        }
        const row = item.row;
        const marked =
          highlight != null &&
          row.rightLine != null &&
          row.rightLine >= highlight.start &&
          row.rightLine <= highlight.end;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
          <div key={i}>
            <div
              className={`group flex ${rowClass(row.kind)}`}
              style={marked ? FOCUS_STYLE : undefined}
              {...(marked && row.rightLine === highlight.start ? { [FOCUS_ATTR]: "true" } : {})}
            >
              <span className="flex w-12 shrink-0 select-none items-center justify-end gap-1 pr-2 text-zinc-600">
                {insights && row.rightLine != null && (
                  <AskAboutLineButton onClick={(extend) => ask(row.rightLine as number, extend)} />
                )}
                {row.rightLine != null && (
                  <AddCommentButton
                    onClick={() => comments.openComposer(row.rightLine as number)}
                  />
                )}
                <span>{row.rightLine ?? ""}</span>
              </span>
              <span className="whitespace-pre">{row.text || " "}</span>
            </div>
            <LineCommentBlock line={row.rightLine} comments={comments} />
            {insights && (
              <InsightBlock
                path={file.filename}
                line={row.rightLine}
                controller={insights}
                currentSha={headSha}
              />
            )}
          </div>
        );
      })}
      {expansion.wholeFile && (
        <ChangeMinimap rows={expansion.rows} totalLines={expansion.totalLines} />
      )}
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

/**
 * Switches a file between its patch and its full text with the changes still
 * highlighted. Sits in the file's own header rather than the review toolbar:
 * wanting the whole file is a per-file question, and applying it to every file
 * at once would pull down the full text of the entire PR.
 */
function WholeFileToggle({
  on,
  loading,
  onClick,
}: {
  on: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // The header is a `<summary>`, so without this the click would also
        // fold the file the reader just asked to see more of.
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      aria-pressed={on}
      title={on ? "Show only the changed parts" : "Show the whole file"}
      className={`shrink-0 rounded border px-2 py-0.5 text-xs ${
        on
          ? "border-sky-700 bg-sky-900/40 text-sky-200"
          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
      }`}
    >
      {loading ? "Loading…" : "Whole file"}
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
  foldAll,
  split,
  headSha,
  focus,
  insights,
}: {
  prRef: PrRef;
  file: PrFile;
  /** Position in the review, deciding whether this file is open on mount. */
  index: number;
  threads: ReviewThread[];
  isViewed: boolean;
  onToggleViewed: (path: string) => void;
  foldAll: FoldAll | null;
  split: boolean;
  /** Commit the file's full text is read at; empty disables expansion. */
  headSha: string;
  /** Set only on the file a guided review is currently pointing at. */
  focus: DiffFocus | null;
  insights: InsightsController;
}) {
  // The first few unviewed files are open on mount; viewed files start
  // collapsed regardless so the user's prior progress stays out of the way.
  // The rest open as the reader scrolls toward them, so a large Azure PR
  // doesn't fetch every file's content up front. Marking viewed later also
  // collapses the diff and unmarking re-expands it (see `toggleViewed` below).
  const [open, setOpen] = useState(!isViewed && index < PREFETCH_COUNT);
  // A file that was closed by a deliberate act — the reader folding it, marking
  // it viewed, or a "Collapse all" — stays folded. Auto-expand exists to save
  // clicks, not to overrule a decision already made.
  const [closedDeliberately, setClosedDeliberately] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useExpandOnApproach(detailsRef, !open && !isViewed && !closedDeliberately, () => setOpen(true));

  // Apply a fold/unfold broadcast from the toolbar. Keyed on the epoch alone so
  // a repeat press re-applies to files toggled by hand in between.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-applies per press, not per value change
  useEffect(() => {
    if (!foldAll) return;
    setOpen(foldAll.open);
    setClosedDeliberately(!foldAll.open);
  }, [foldAll?.epoch]);

  // A guided review pointing here opens the file and scrolls to its lines,
  // overriding a deliberate collapse — the reader asked to be taken to this
  // code, which outranks having folded it away earlier.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs per landing, not per value change
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    setClosedDeliberately(false);
    // Two frames: the first commits the expansion, the second lets the diff
    // rows lay out, so the marked line exists to scroll to. Without the diff
    // rendered the scroll would land on the file header instead.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const fileEl = detailsRef.current;
        const line = fileEl?.querySelector(`[${FOCUS_ATTR}]`);
        (line ?? fileEl)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }),
    );
  }, [focus?.nonce]);

  const { data: loaded, loading } = usePrFileDiff(prRef, file, open);
  const patch = loaded?.patch ?? file.patch;
  const highlight = focusRange(focus);
  const fileThreads = useMemo(
    () => threads.filter((t) => t.path === file.filename),
    [threads, file.filename],
  );
  const expansion = useFileExpansion(prRef, file.filename, patch ?? "", headSha);

  // Single handler so the visual collapse and the underlying viewed mutation
  // happen together — the diff folds away exactly when the user marks it done
  // and pops back open if they undo. Keeping them coupled here avoids a flash
  // where the diff is still expanded under a "Viewed" pill (or vice versa).
  const toggleViewed = () => {
    const nowViewed = !isViewed;
    setOpen(isViewed);
    onToggleViewed(file.filename);
    // Collapsing a file you've scrolled into yanks everything below it upward
    // while the scroll position stays put, so the viewport lands mid-way through
    // a different file — it reads as the whole page jumping/"refreshing". When
    // the file's own header is already pinned at (or scrolled above) the top of
    // the review pane, re-anchor that header to the top after the collapse so
    // the user stays oriented on the file they just finished. Files still fully
    // below the fold don't move the top of the viewport, so they're left alone.
    if (!nowViewed) return;
    // The rAF lets React commit the collapse first, so we measure the folded
    // layout. The scroll pane is found via the `data-pr-scroll` marker set in
    // PrDetailView. Instant (not smooth) scroll: this is a re-anchor to keep the
    // header in place, not a navigation, so an animation would just look like a
    // stutter on collapse.
    requestAnimationFrame(() => {
      const fileEl = document.getElementById(prFileAnchorId(prRef, file.filename));
      const pane = fileEl?.closest("[data-pr-scroll]");
      if (!fileEl || !pane) return;
      if (fileEl.getBoundingClientRect().top <= pane.getBoundingClientRect().top) {
        fileEl.scrollIntoView({ block: "start" });
      }
    });
  };

  return (
    <details
      ref={detailsRef}
      id={prFileAnchorId(prRef, file.filename)}
      open={open}
      onToggle={(e) => {
        const nowOpen = e.currentTarget.open;
        setOpen(nowOpen);
        setClosedDeliberately(!nowOpen);
      }}
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
        <CopyPathButton path={file.filename} />
        {file.additions + file.deletions > 0 && (
          <>
            <span className="text-xs text-emerald-400">+{file.additions}</span>
            <span className="text-xs text-red-400">−{file.deletions}</span>
          </>
        )}
        {file.status !== "modified" && <span className="text-xs text-zinc-500">{file.status}</span>}
        {open && patch && expansion.canExpand && (
          <WholeFileToggle
            on={expansion.wholeFile}
            loading={expansion.loading}
            onClick={() => expansion.setWholeFile(!expansion.wholeFile)}
          />
        )}
        <ViewedToggle isViewed={isViewed} onClick={toggleViewed} />
      </summary>
      {open &&
        (loading && !patch ? (
          <p className="px-3 py-2 text-xs text-zinc-600">Loading diff…</p>
        ) : patch ? (
          <>
            {expansion.error && (
              <p className="px-3 py-1 text-xs text-red-400">
                Could not load the rest of this file: {expansion.error}
              </p>
            )}
            {split ? (
              <SplitDiffBody
                prRef={prRef}
                file={loaded ?? file}
                threads={fileThreads}
                expansion={expansion}
                highlight={highlight}
                insights={insights}
                headSha={headSha}
              />
            ) : (
              <DiffBody
                prRef={prRef}
                file={loaded ?? file}
                threads={fileThreads}
                expansion={expansion}
                highlight={highlight}
                insights={insights}
                headSha={headSha}
              />
            )}
          </>
        ) : (
          <p className="px-3 py-2 text-xs text-zinc-600">No textual diff (binary or too large).</p>
        ))}
    </details>
  );
}

/** The changed files of a PR rendered as expandable, comment-able diffs. */
export default function PrFileDiffs({
  prRef,
  viewed,
  onToggleViewed,
  focus = null,
}: {
  prRef: PrRef;
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
  /** Where a guided review wants the reader looking, if one is running. */
  focus?: DiffFocus | null;
}) {
  const insights = usePrInsights(prRef);
  const { data, error, loading } = usePrFiles(prRef);
  const detail = usePrDetail(prRef);
  const threads = detail.data?.reviewThreads ?? [];
  const [foldAll, setFoldAll] = useState<FoldAll | null>(null);
  const [split, setSplit] = usePersistedBoolean(SPLIT_VIEW_KEY, false);

  // The same order `PrFileList` shows, so scrolling the diffs walks the tree
  // top to bottom instead of the provider's own file order. Hoisted above the
  // early returns to keep hook order stable.
  const orderedFiles = useMemo(
    () => (data ? flattenFileTree(buildFileTree(data, (f) => f.filename)) : []),
    [data],
  );

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading diff…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  const fold = (open: boolean) => setFoldAll((f) => ({ open, epoch: (f?.epoch ?? 0) + 1 }));

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <span>
          {data.length} {data.length === 1 ? "file" : "files"}
        </span>
        <div className="ml-auto flex overflow-hidden rounded border border-zinc-700">
          <button
            type="button"
            onClick={() => setSplit(false)}
            aria-pressed={!split}
            className={`px-2 py-0.5 ${
              split ? "hover:bg-zinc-800 hover:text-zinc-200" : "bg-zinc-800 text-zinc-200"
            }`}
          >
            Unified
          </button>
          <button
            type="button"
            onClick={() => setSplit(true)}
            aria-pressed={split}
            className={`border-l border-zinc-700 px-2 py-0.5 ${
              split ? "bg-zinc-800 text-zinc-200" : "hover:bg-zinc-800 hover:text-zinc-200"
            }`}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={() => fold(false)}
          className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-200"
        >
          Collapse all
        </button>
        <button
          type="button"
          onClick={() => fold(true)}
          className="rounded border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 hover:text-zinc-200"
        >
          Expand all
        </button>
      </div>
      {orderedFiles.map(({ file: f }, i) => (
        <FileDiff
          key={f.filename}
          prRef={prRef}
          file={f}
          index={i}
          threads={threads}
          isViewed={viewed.has(f.filename)}
          onToggleViewed={onToggleViewed}
          foldAll={foldAll}
          split={split}
          headSha={detail.data?.headSha ?? ""}
          focus={focus?.path === f.filename ? focus : null}
          insights={insights}
        />
      ))}
    </div>
  );
}
