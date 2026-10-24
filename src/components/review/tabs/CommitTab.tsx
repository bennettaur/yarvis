import { memo, useState } from "react";
import { refKey } from "../../../lib/pr/ref";
import type { ReviewChangedFile } from "../../../lib/reviewWorkspaces/api";
import { useCommitFileDiff, useCommitFiles } from "../../../lib/reviewWorkspaces/sinceReview";
import LoadingIndicator from "../../LoadingIndicator";
import { MonacoDiffView, snapshotUri } from "../editor";
import { CenteredNote } from "./FileChrome";
import type { TabContext } from "./types";

const STATUS_MARK: Record<ReviewChangedFile["status"], { text: string; className: string }> = {
  added: { text: "A", className: "text-emerald-400" },
  modified: { text: "M", className: "text-amber-400" },
  deleted: { text: "D", className: "text-red-400" },
  renamed: { text: "R", className: "text-sky-400" },
};

/** One file of a commit, its parent's version against its own. */
function CommitFileDiff({
  ctx,
  sha,
  file,
}: {
  ctx: TabContext;
  sha: string;
  file: ReviewChangedFile;
}) {
  const diff = useCommitFileDiff(ctx.workspaceId, ctx.pr.id, sha, file.path);
  if (file.binary) return <CenteredNote>Binary file — no text diff to show.</CenteredNote>;
  if (diff.error && !diff.data) return <CenteredNote tone="error">{diff.error}</CenteredNote>;
  if (!diff.data) {
    return (
      <CenteredNote>
        <LoadingIndicator label="Loading diff…" />
      </CenteredNote>
    );
  }
  if (diff.data.tooLarge) return <CenteredNote>This file is too large to show here.</CenteredNote>;
  const key = refKey(ctx.prRef);
  return (
    <MonacoDiffView
      originalUri={snapshotUri(key, `commit-${diff.data.parentSha}`, file.oldPath ?? file.path)}
      modifiedUri={snapshotUri(key, `commit-${sha}`, file.path)}
      path={file.path}
      original={diff.data.original?.content ?? ""}
      modified={diff.data.modified?.content ?? ""}
      sideBySide={ctx.diffMode === "split"}
      hideUnchanged
    />
  );
}

/**
 * One of the PR's commits on its own: the files it touched, and the diff of
 * the one picked against the commit's first parent. A merge commit therefore
 * shows what the merge brought in from the base.
 */
export default memo(function CommitTab({
  ctx,
  sha,
  subject,
}: {
  ctx: TabContext;
  sha: string;
  subject?: string;
}) {
  const files = useCommitFiles(ctx.workspaceId, ctx.pr.id, sha);
  const [picked, setPicked] = useState<string | null>(null);
  if (files.error && !files.data) return <CenteredNote tone="error">{files.error}</CenteredNote>;
  if (!files.data) {
    return (
      <CenteredNote>
        <LoadingIndicator label="Loading commit…" />
      </CenteredNote>
    );
  }
  const list = files.data.files;
  const current = list.find((f) => f.path === picked) ?? list[0] ?? null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="font-mono text-zinc-400">{sha.slice(0, 7)}</span>
        <span className="min-w-0 truncate text-zinc-200">{subject}</span>
        <span className="ml-auto shrink-0 text-zinc-500">
          {list.length} {list.length === 1 ? "file" : "files"}
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <ul
          className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800 py-1"
          aria-label="Files in this commit"
        >
          {list.map((file) => {
            const mark = STATUS_MARK[file.status];
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setPicked(file.path)}
                  title={file.path}
                  className={`flex w-full items-center gap-1.5 px-2 py-0.5 text-left text-xs ${
                    current?.path === file.path
                      ? "bg-zinc-800 text-zinc-100"
                      : "text-zinc-300 hover:bg-zinc-800/60"
                  }`}
                >
                  <span className={`w-3 shrink-0 font-mono ${mark.className}`}>{mark.text}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="relative min-h-0 min-w-0 flex-1">
          {current ? (
            <CommitFileDiff key={current.path} ctx={ctx} sha={sha} file={current} />
          ) : (
            <CenteredNote>This commit changes no files.</CenteredNote>
          )}
        </div>
      </div>
    </div>
  );
});
