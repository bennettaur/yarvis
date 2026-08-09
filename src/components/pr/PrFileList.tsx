import { useMemo, useState } from "react";
import { usePrFiles } from "../../lib/pr/cache";
import type { PrRef } from "../../lib/pr/types";
import CopyPathButton from "./CopyPathButton";
import { buildFileTree, type FileTreeFile, type FileTreeNode } from "./fileTree";
import { prFileAnchorId } from "./shared";

const STATUS_LETTER: Record<string, { letter: string; color: string }> = {
  added: { letter: "A", color: "text-emerald-400" },
  removed: { letter: "D", color: "text-red-400" },
  modified: { letter: "M", color: "text-amber-400" },
  renamed: { letter: "R", color: "text-sky-400" },
};

/** Left padding per tree depth, so nested rows line up under their folder. */
const INDENT_PER_DEPTH = 12;
/** Base left padding for a depth-0 row, matching the `px-2` on each row. */
const ROW_PADDING_LEFT = 8;

/**
 * Compact tree of a PR's changed files. Files nest under collapsible folders
 * (native `<details>`, open by default). Clicking a file scrolls the matching
 * `PrFileDiffs` entry into view (by shared anchor id, so it works whether the
 * diffs sit beside it or elsewhere on the page). A per-row checkbox marks the
 * file as viewed; clicks on the checkbox don't trigger the scroll so toggling
 * never moves focus away. Rows only show a basename, so each also carries a
 * copy button for the full path.
 */
export default function PrFileList({
  prRef,
  onCollapse,
  viewed,
  onToggleViewed,
}: {
  prRef: PrRef;
  /** When set, renders a button in the header to collapse the whole panel. */
  onCollapse?: () => void;
  /** Paths the viewer has marked viewed. */
  viewed: Set<string>;
  onToggleViewed: (path: string) => void;
}) {
  const { data, error, loading } = usePrFiles(prRef);
  const [selected, setSelected] = useState<string | null>(null);

  // Hoisted above the early returns to keep hook order stable.
  const viewedCount = useMemo(
    () => (data ? data.filter((f) => viewed.has(f.filename)).length : 0),
    [data, viewed],
  );
  const tree = useMemo(() => (data ? buildFileTree(data) : []), [data]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading files…</p>;
  if (data.length === 0) return <p className="text-sm text-zinc-600">No file changes.</p>;

  const onClick = (path: string) => {
    setSelected(path);
    document
      .getElementById(prFileAnchorId(prRef, path))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        {tree.map((node) => (
          <TreeRows
            key={nodeKey(node)}
            node={node}
            depth={0}
            selected={selected}
            viewed={viewed}
            onClick={onClick}
            onToggleViewed={onToggleViewed}
          />
        ))}
      </ul>
    </div>
  );
}

function nodeKey(node: FileTreeNode): string {
  return node.type === "dir" ? `dir:${node.path}` : `file:${node.file.filename}`;
}

/** Recursively render one tree node (a collapsible folder or a file row). */
function TreeRows({
  node,
  depth,
  selected,
  viewed,
  onClick,
  onToggleViewed,
}: {
  node: FileTreeNode;
  depth: number;
  selected: string | null;
  viewed: Set<string>;
  onClick: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  if (node.type === "file") {
    return (
      <FileRow
        node={node}
        depth={depth}
        selected={selected}
        viewed={viewed}
        onClick={onClick}
        onToggleViewed={onToggleViewed}
      />
    );
  }

  return (
    <li>
      <details open className="group">
        <summary
          className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          style={{ paddingLeft: depth * INDENT_PER_DEPTH + ROW_PADDING_LEFT }}
        >
          <span className="text-zinc-600 transition-transform group-open:rotate-90">▶</span>
          <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
        </summary>
        <ul className="space-y-0.5">
          {node.children.map((child) => (
            <TreeRows
              key={nodeKey(child)}
              node={child}
              depth={depth + 1}
              selected={selected}
              viewed={viewed}
              onClick={onClick}
              onToggleViewed={onToggleViewed}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

function FileRow({
  node,
  depth,
  selected,
  viewed,
  onClick,
  onToggleViewed,
}: {
  node: FileTreeFile;
  depth: number;
  selected: string | null;
  viewed: Set<string>;
  onClick: (path: string) => void;
  onToggleViewed: (path: string) => void;
}) {
  const { file, name } = node;
  const status = STATUS_LETTER[file.status] ?? { letter: "•", color: "text-zinc-500" };
  const isViewed = viewed.has(file.filename);
  return (
    <li>
      <div
        className={`group/row flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800 ${
          selected === file.filename ? "bg-zinc-800" : ""
        } ${isViewed ? "opacity-60" : ""}`}
        style={{ paddingLeft: depth * INDENT_PER_DEPTH + ROW_PADDING_LEFT }}
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
            above, so an unnamed `group-hover:` would reveal every file's button
            whenever any part of the folder is hovered. */}
        <CopyPathButton
          path={file.filename}
          className="opacity-0 transition-opacity focus:opacity-100 group-hover/row:opacity-100"
        />
      </div>
    </li>
  );
}
