import type { ReactNode } from "react";
import type { FileTreeFile, FileTreeNode } from "../../lib/fileTree";

/** Left padding per tree depth, so nested rows line up under their folder. */
const INDENT_PER_DEPTH = 12;
/** Base left padding for a depth-0 row, matching the `px-2` on each row. */
const ROW_PADDING_LEFT = 8;

/**
 * Left padding a file row needs to sit under its folder. The indent lives on
 * the row the caller renders rather than on the `<li>` around it, so a row's
 * hover background still spans the panel's full width.
 */
export function treeRowPaddingLeft(depth: number): number {
  return depth * INDENT_PER_DEPTH + ROW_PADDING_LEFT;
}

/**
 * The folder half of a file tree: collapsible `<details>` rows wrapping their
 * children. The caller owns the enclosing `<ul>` and renders each file row
 * itself through `renderFile`, indenting it with `treeRowPaddingLeft`. Sharing
 * this keeps a PR's changed files and a workspace's file lists on one layout.
 */
export default function FileTreeRows<T>({
  nodes,
  renderFile,
}: {
  nodes: FileTreeNode<T>[];
  renderFile: (node: FileTreeFile<T>, depth: number) => ReactNode;
}) {
  return <Rows nodes={nodes} renderFile={renderFile} depth={0} />;
}

function Rows<T>({
  nodes,
  renderFile,
  depth,
}: {
  nodes: FileTreeNode<T>[];
  renderFile: (node: FileTreeFile<T>, depth: number) => ReactNode;
  depth: number;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "file" ? (
          // Keys carry the node type as well as the path: a folder and a file
          // can sit side by side under the same path.
          <li key={`file:${node.path}`}>{renderFile(node, depth)}</li>
        ) : (
          <li key={`dir:${node.path}`}>
            <details open className="group">
              <summary
                className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                style={{ paddingLeft: treeRowPaddingLeft(depth) }}
              >
                <span
                  aria-hidden="true"
                  className="text-zinc-600 transition-transform group-open:rotate-90"
                >
                  ▶
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
              </summary>
              <ul className="space-y-0.5">
                <Rows nodes={node.children} renderFile={renderFile} depth={depth + 1} />
              </ul>
            </details>
          </li>
        ),
      )}
    </>
  );
}
