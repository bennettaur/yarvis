import { useMemo, useState } from "react";
import { buildFileTree, type FileTreeFile } from "../../lib/fileTree";
import { usePrDetail, usePrFiles } from "../../lib/pr/cache";
import type { PrFile, PrRef } from "../../lib/pr/types";
import FileTreeRows, { treeRowPaddingLeft } from "../files/FileTreeRows";
import CopyFileLinkButton from "./CopyFileLinkButton";
import CopyPathButton from "./CopyPathButton";
import { flashFile } from "./flashFile";
import { prFileAnchorId } from "./shared";

const STATUS_LETTER: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "text-emerald-400" },
  removed: { letter: "D", color: "text-red-400" },
  modified: { letter: "M", color: "text-amber-400" },
  renamed: { letter: "R", color: "text-sky-400" },
};

/**
 * Compact tree of a PR's changed files. Files nest under collapsible folders
 * (native `<details>`, open by default). Clicking a file scrolls the matching
 * `PrFileDiffs` entry into view (by shared anchor id, so it works whether the
 * diffs sit beside it or elsewhere on the page) and flashes its header to show
 * where the scroll landed. A per-row checkbox marks the file as viewed; clicks
 * on the checkbox don't trigger the scroll so toggling never moves focus away.
 * Rows only show a basename, so each also carries a copy button for the full
 * path.
 */
export default function PrFileList({
  prRef,
  prUrl = "",
  onCollapse,
  viewed,
  onToggleViewed,
}: {
  prRef: PrRef;
  /**
   * The PR's web URL, which the per-file provider links are derived from. Empty
   * where the host doesn't know it (an Omni widget names a PR by owner/repo/number
   * only), which drops those links rather than guessing a hostname.
   */
  prUrl?: string;
  /** When set, renders a button in the header to collapse the whole panel. */
  onCollapse?: () => void;
  /** Paths the viewer has marked viewed. */
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
}) {
  const { data, error, loading } = usePrFiles(prRef);
  // Shares the detail cache with the rest of the review, so naming it here is
  // only for the head commit the file links are pinned to.
  const detail = usePrDetail(prRef);
  const [selected, setSelected] = useState<string | null>(null);

  // Hoisted above the early returns to keep hook order stable.
  const viewedCount = useMemo(
    () => (data ? data.filter((f) => viewed.has(f.filename)).length : 0),
    [data, viewed],
  );
  const tree = useMemo(() => (data ? buildFileTree(data, (f) => f.filename) : []), [data]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading files…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  const onClick = (path: string) => {
    setSelected(path);
    const fileEl = document.getElementById(prFileAnchorId(prRef, path));
    fileEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    flashFile(fileEl);
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-2 text-xs text-zinc-500">
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse file list"
            aria-label="Collapse file list"
            className="text-zinc-500 hover:text-zinc-300"
          >
            ‹
          </button>
        )}
        <span>
          {viewedCount}/{data.length} viewed
        </span>
      </div>
      <ul className="space-y-0.5 text-sm">
        <FileTreeRows
          nodes={tree}
          renderFile={(node, depth) => (
            <FileRow
              node={node}
              depth={depth}
              selected={selected}
              viewed={viewed}
              onClick={onClick}
              onToggleViewed={onToggleViewed}
              prRef={prRef}
              prUrl={prUrl}
              headSha={detail.data?.headSha ?? ""}
            />
          )}
        />
      </ul>
    </div>
  );
}

function FileRow({
  node,
  depth,
  selected,
  viewed,
  onClick,
  onToggleViewed,
  prRef,
  prUrl,
  headSha,
}: {
  node: FileTreeFile<PrFile>;
  depth: number;
  selected: string | null;
  viewed: Set<string>;
  onClick: (path: string) => void;
  onToggleViewed: (path: string) => void;
  prRef: PrRef;
  prUrl: string;
  headSha: string;
}) {
  const { file, name } = node;
  const status = STATUS_LETTER[file.status] ?? { letter: "•", color: "text-zinc-500" };
  const isViewed = viewed.has(file.filename);
  return (
    <div
      className={`group/row flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800 ${
        selected === file.filename ? "bg-zinc-800" : ""
      } ${isViewed ? "opacity-60" : ""}`}
      style={{ paddingLeft: treeRowPaddingLeft(depth) }}
    >
      <input
        type="checkbox"
        checked={isViewed}
        onChange={(e) => {
          // Toggling viewed must never trigger the row's file-select scroll.
          // The checkbox is a sibling of that button today, but stop the event
          // defensively so a future row-level handler can't hijack the toggle.
          e.stopPropagation();
          onToggleViewed(file.filename);
        }}
        onClick={(e) => e.stopPropagation()}
        className="h-3.5 w-3.5 shrink-0 accent-emerald-500"
        title={isViewed ? "Mark unviewed" : "Mark viewed"}
        aria-label={`Mark ${file.filename} ${isViewed ? "unviewed" : "viewed"}`}
      />
      <button
        type="button"
        onClick={() => onClick(file.filename)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        title={file.filename}
      >
        <span className={`${status.color} shrink-0 font-mono text-xs`}>{status.letter}</span>
        <span
          className={`min-w-0 flex-1 truncate font-mono text-xs ${
            isViewed ? "text-zinc-500 line-through" : "text-zinc-300"
          }`}
        >
          {name}
        </span>
        {file.additions + file.deletions > 0 && (
          <>
            <span className="shrink-0 text-xs text-emerald-400">+{file.additions}</span>
            <span className="shrink-0 text-xs text-red-400">−{file.deletions}</span>
          </>
        )}
      </button>
      {/* Named group, unlike the bare `group` every other hover-reveal in the
          app uses: these rows sit inside the folder `<details className="group">`
          that `FileTreeRows` renders, so an unnamed `group-hover:` would reveal
          every file's button whenever any part of the folder is hovered. */}
      <CopyPathButton
        path={file.filename}
        className="opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100"
      />
      <CopyFileLinkButton
        prRef={prRef}
        prUrl={prUrl}
        headSha={headSha}
        path={file.filename}
        className="opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100"
      />
    </div>
  );
}
