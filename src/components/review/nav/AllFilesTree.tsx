import { useMemo, useState } from "react";
import { buildFileTree, type FileTreeNode } from "../../../lib/fileTree";
import { treeRowPaddingLeft } from "../../files/FileTreeRows";
import LoadingIndicator from "../../LoadingIndicator";
import { useReviewChangedFiles, useReviewTree } from "../tabs/reviewData";
import type { FilesTreeProps } from "./ChangedFilesTree";

/** Most matches a filter lists; past that the reader narrows it. */
const MAX_MATCHES = 200;

/**
 * Paths matching a filter: every space-separated word must appear, in any
 * case, so "tabs diff" finds `src/components/review/tabs/DiffTab.tsx`.
 */
export function filterPaths(paths: readonly string[], query: string, max = MAX_MATCHES): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (words.every((w) => lower.includes(w))) {
      out.push(p);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * Every file at the PR's head, for reading code the change doesn't touch.
 * Folders start closed and render their contents only once opened, since a
 * whole repository is far more rows than the nav should build up front. A
 * file the PR changes is marked and opens as its diff; anything else opens
 * whole.
 */
export default function AllFilesTree({
  workspaceId,
  pr,
  color,
  activePath,
  openTab,
}: FilesTreeProps) {
  const tree = useReviewTree(workspaceId, pr);
  const changed = useReviewChangedFiles(workspaceId, pr);
  const [query, setQuery] = useState("");

  const paths = tree.data?.paths;
  const nodes = useMemo(() => (paths ? buildFileTree(paths, (p) => p) : []), [paths]);
  const changedPaths = useMemo(
    () => new Set((changed.data?.files ?? []).map((f) => f.path)),
    [changed.data],
  );
  const matches = useMemo(() => (paths ? filterPaths(paths, query) : []), [paths, query]);

  if (!pr.headSha) return <p className="px-2 text-xs text-zinc-500">Fetching the pull request…</p>;
  if (tree.error && !paths) return <p className="px-2 text-xs text-red-400">{tree.error}</p>;
  if (!paths)
    return <LoadingIndicator label="Loading files…" className="px-2 text-xs text-zinc-500" />;

  const open = (path: string) =>
    openTab({ kind: changedPaths.has(path) ? "diff" : "file", prId: pr.id, path });

  const fileRow = (path: string, label: string, depth: number) => (
    <button
      type="button"
      onClick={() => open(path)}
      title={path}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-0.5 text-left hover:bg-zinc-800 ${
        activePath === path ? `bg-zinc-800 ${color.text}` : "text-zinc-300"
      }`}
      style={{ paddingLeft: treeRowPaddingLeft(depth) }}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{label}</span>
      {changedPaths.has(path) && (
        <span
          role="img"
          aria-label="Changed in this pull request"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
        />
      )}
    </button>
  );

  return (
    <div className="space-y-1">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Filter ${paths.length} files…`}
        aria-label="Filter files"
        className="mx-2 w-[calc(100%-1rem)] rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-200"
      />
      {query.trim() ? (
        <ul className="space-y-0.5">
          {matches.length === 0 && <li className="px-2 text-xs text-zinc-500">No matches.</li>}
          {matches.map((p) => (
            <li key={p}>{fileRow(p, p, 0)}</li>
          ))}
          {matches.length >= MAX_MATCHES && (
            <li className="px-2 text-[11px] text-zinc-500">
              First {MAX_MATCHES} shown; keep typing to narrow.
            </li>
          )}
        </ul>
      ) : (
        <ul className="space-y-0.5">
          <LazyRows nodes={nodes} depth={0} fileRow={fileRow} />
        </ul>
      )}
    </div>
  );
}

function LazyRows({
  nodes,
  depth,
  fileRow,
}: {
  nodes: FileTreeNode<string>[];
  depth: number;
  fileRow: (path: string, label: string, depth: number) => React.ReactNode;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "file" ? (
          <li key={`file:${node.path}`}>{fileRow(node.path, node.name, depth)}</li>
        ) : (
          <LazyDir key={`dir:${node.path}`} node={node} depth={depth} fileRow={fileRow} />
        ),
      )}
    </>
  );
}

function LazyDir({
  node,
  depth,
  fileRow,
}: {
  node: Extract<FileTreeNode<string>, { type: "dir" }>;
  depth: number;
  fileRow: (path: string, label: string, depth: number) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-left text-xs text-zinc-400 hover:bg-zinc-800"
        style={{ paddingLeft: treeRowPaddingLeft(depth) }}
      >
        <span
          aria-hidden="true"
          className={`text-zinc-600 transition-transform ${open ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      </button>
      {open && (
        <ul className="space-y-0.5">
          <LazyRows nodes={node.children} depth={depth + 1} fileRow={fileRow} />
        </ul>
      )}
    </li>
  );
}
