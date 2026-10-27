import { useMemo } from "react";
import { buildFileTree, type FileTreeFile } from "../../../lib/fileTree";
import { usePrDetail } from "../../../lib/pr/cache";
import type { ReviewChangedFile, ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import type { VerificationMustRead } from "../../../lib/reviewWorkspaces/verification";
import FileTreeRows, { treeRowPaddingLeft } from "../../files/FileTreeRows";
import LoadingIndicator from "../../LoadingIndicator";
import { commentCountsByPath, openThreadsByPath } from "../tabs/annotations";
import {
  mustReadByPath,
  reportOf,
  useLatestVerification,
  useReviewChangedFiles,
  useReviewViewed,
} from "../tabs/reviewData";
import type { PrColor, TabSpec } from "../tabs/types";

export interface FilesTreeProps {
  workspaceId: string;
  pr: ReviewWorkspacePr;
  color: PrColor;
  /** The file of this PR in the focused tab, highlighted in the tree. */
  activePath: string | null;
  openTab: (spec: TabSpec) => void;
}

const STATUS_LETTER: Record<ReviewChangedFile["status"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-emerald-400" },
  modified: { letter: "M", className: "text-amber-400" },
  deleted: { letter: "D", className: "text-red-400" },
  renamed: { letter: "R", className: "text-sky-400" },
};

/** The marker for a file the verification report says to read, with why on hover. */
export function MustReadMarker({ entry }: { entry: VerificationMustRead }) {
  return (
    <span
      role="img"
      aria-label={`Must read: ${entry.reason}`}
      title={`Must read: ${entry.reason}`}
      className="shrink-0 text-[11px] text-amber-400"
    >
      ★
    </span>
  );
}

/** A file's comment count, amber while one of its threads is still open. */
export function CommentCount({ count, open }: { count: number; open: boolean }) {
  return (
    <span
      role="img"
      aria-label={`${count} ${count === 1 ? "comment" : "comments"}${open ? ", unresolved" : ""}`}
      className={`flex shrink-0 items-center gap-0.5 text-[11px] ${open ? "text-amber-400" : "text-zinc-500"}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="none">
        <path
          d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
      {count}
    </span>
  );
}

/**
 * A PR's changed files for the left nav, as a tree of collapsible folders.
 * Each row carries what decides where to look next — viewed, must-read,
 * comments — and opens the file's diff tab.
 */
export default function ChangedFilesTree({
  workspaceId,
  pr,
  color,
  activePath,
  openTab,
}: FilesTreeProps) {
  const changed = useReviewChangedFiles(workspaceId, pr);
  const viewed = useReviewViewed(pr.ref);
  const detail = usePrDetail(pr.ref);
  const latest = useLatestVerification(workspaceId, pr.id);

  const files = changed.data?.files;
  const tree = useMemo(() => (files ? buildFileTree(files, (f) => f.path) : []), [files]);
  const threads = detail.data?.reviewThreads;
  const counts = useMemo(() => commentCountsByPath(threads ?? []), [threads]);
  const open = useMemo(() => openThreadsByPath(threads ?? []), [threads]);
  const report = reportOf(latest.data);
  const mustRead = useMemo(() => mustReadByPath(report), [report]);

  if (!pr.headSha) return <p className="px-2 text-xs text-zinc-500">Fetching the pull request…</p>;
  if (changed.error && !files) return <p className="px-2 text-xs text-red-400">{changed.error}</p>;
  if (!files)
    return <LoadingIndicator label="Loading files…" className="px-2 text-xs text-zinc-500" />;
  if (files.length === 0) return <p className="px-2 text-xs text-zinc-500">No file changes.</p>;

  const viewedCount = files.filter((f) => viewed.viewed.has(f.path)).length;

  const row = (node: FileTreeFile<ReviewChangedFile>, depth: number) => {
    const file = node.file;
    const isViewed = viewed.viewed.has(file.path);
    const status = STATUS_LETTER[file.status];
    const must = mustRead.get(file.path);
    const count = counts.get(file.path) ?? 0;
    return (
      <div
        className={`flex w-full items-center gap-1.5 rounded px-2 py-0.5 hover:bg-zinc-800 ${
          activePath === file.path ? `bg-zinc-800 ${color.text}` : ""
        } ${isViewed ? "opacity-60" : ""}`}
        style={{ paddingLeft: treeRowPaddingLeft(depth) }}
      >
        <input
          type="checkbox"
          checked={isViewed}
          disabled={!viewed.ready}
          onChange={() => void viewed.toggle(file.path)}
          className="h-3 w-3 shrink-0 accent-emerald-500"
          aria-label={`Mark ${file.path} ${isViewed ? "unviewed" : "viewed"}`}
        />
        <button
          type="button"
          onClick={() => openTab({ kind: "diff", prId: pr.id, path: file.path })}
          title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className={`w-3 shrink-0 font-mono text-[11px] ${status.className}`}>
            {status.letter}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
        </button>
        {must && <MustReadMarker entry={must} />}
        {count > 0 && <CommentCount count={count} open={open.has(file.path)} />}
      </div>
    );
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 px-2 text-[11px] text-zinc-500">
        <span>
          {viewedCount}/{files.length} viewed
        </span>
        {mustRead.size > 0 && (
          <span className="text-amber-400/80">★ {mustRead.size} must read</span>
        )}
      </div>
      {viewed.error && <p className="px-2 text-[11px] text-red-400">{viewed.error}</p>}
      <ul className="space-y-0.5">
        <FileTreeRows nodes={tree} renderFile={row} />
      </ul>
    </div>
  );
}
