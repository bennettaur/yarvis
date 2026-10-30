import { memo, useMemo, useState } from "react";
import { buildFileTree, flattenFileTree } from "../../../lib/fileTree";
import type { ReviewChangedFile } from "../../../lib/reviewWorkspaces/api";
import { seenAt } from "../../../lib/reviewWorkspaces/sinceReview";
import type { VerificationMustRead } from "../../../lib/reviewWorkspaces/verification";
import LoadingIndicator from "../../LoadingIndicator";
import { MonacoDiffView } from "../editor";
import { useReviewNavigation } from "../navigation";
import { AnnotationBar, CenteredNote } from "./FileChrome";
import FileTab from "./FileTab";
import { type FileNote, fileNotes, reportDecorations } from "./reportHighlights";
import {
  modelUri,
  mustReadFor,
  reportOf,
  useLatestVerification,
  useReviewChangedFiles,
  useReviewFile,
  useReviewViewed,
} from "./reviewData";
import type { TabContext } from "./types";
import { useFileAnnotations } from "./useFileAnnotations";
import { useReveal } from "./useReveal";

const STATUS_LABEL: Record<ReviewChangedFile["status"], { text: string; className: string }> = {
  added: { text: "Added", className: "text-emerald-400" },
  modified: { text: "Modified", className: "text-amber-400" },
  deleted: { text: "Deleted", className: "text-red-400" },
  renamed: { text: "Renamed", className: "text-sky-400" },
};

/** The changed files in the order the tree lists them, which is the order "next" walks. */
export function changedFileOrder(files: readonly ReviewChangedFile[]): string[] {
  return flattenFileTree(buildFileTree([...files], (f) => f.path)).map((n) => n.path);
}

/** The first file after `path` (wrapping round) that isn't viewed yet. */
export function nextUnviewed(
  order: readonly string[],
  path: string,
  viewed: ReadonlySet<string>,
): string | null {
  const at = order.indexOf(path);
  for (let i = 1; i <= order.length; i++) {
    const candidate = order[(at + i) % order.length];
    if (candidate !== path && !viewed.has(candidate)) return candidate;
  }
  return null;
}

/**
 * One changed file as a diff: only the changes, with the unchanged stretches
 * folded behind bars that expand them, and the PR's threads, the reviewer's
 * questions and a comment composer inline on either side.
 *
 * A path the PR doesn't change opens as a plain file instead, so a link from a
 * guide step or a report into an untouched file still lands somewhere.
 */
export default memo(function DiffTab({
  ctx,
  path,
  revealLine,
  revealNonce,
}: {
  ctx: TabContext;
  path: string;
  revealLine?: number;
  revealNonce?: number;
}) {
  const changed = useReviewChangedFiles(ctx.workspaceId, ctx.pr);
  const files = changed.data?.files;
  const order = useMemo(() => (files ? changedFileOrder(files) : []), [files]);
  if (changed.error && !changed.data)
    return <CenteredNote tone="error">{changed.error}</CenteredNote>;
  if (!changed.data) {
    return ctx.pr.headSha ? (
      <CenteredNote>
        <LoadingIndicator label="Loading changes…" />
      </CenteredNote>
    ) : (
      <CenteredNote>The pull request is still being fetched.</CenteredNote>
    );
  }
  const file = changed.data.files.find((f) => f.path === path);
  if (!file) {
    return <FileTab ctx={ctx} path={path} revealLine={revealLine} revealNonce={revealNonce} />;
  }
  return (
    <ChangedFileDiff
      ctx={ctx}
      file={file}
      order={order}
      revealLine={revealLine}
      revealNonce={revealNonce}
    />
  );
});

function ChangedFileDiff({
  ctx,
  file,
  order,
  revealLine,
  revealNonce,
}: {
  ctx: TabContext;
  file: ReviewChangedFile;
  order: string[];
  revealLine?: number;
  revealNonce?: number;
}) {
  const { path } = file;
  const basePath = file.oldPath ?? path;
  const hasBase = file.status !== "added";
  const hasHead = file.status !== "deleted";
  const base = useReviewFile(
    ctx.workspaceId,
    ctx.pr,
    hasBase && !file.binary ? basePath : null,
    "base",
  );
  const head = useReviewFile(
    ctx.workspaceId,
    ctx.pr,
    hasHead && !file.binary ? path : null,
    "head",
  );
  const viewed = useReviewViewed(ctx.prRef);
  const latest = useLatestVerification(ctx.workspaceId, ctx.pr.id);
  const report = reportOf(latest.data);
  const mustRead = mustReadFor(report, path);
  const notes = useMemo(() => fileNotes(report, path), [report, path]);
  const decorations = useMemo(() => reportDecorations(mustRead, notes), [mustRead, notes]);
  const [showAll, setShowAll] = useState(false);
  const reveal = useReveal(revealLine, revealNonce);
  const { onOpenLocation } = useReviewNavigation(ctx);

  const headContent = head.data?.content ?? "";
  const annotations = useFileAnnotations({
    prRef: ctx.prRef,
    path,
    headContent,
    headSha: ctx.pr.headSha ?? "",
    canComment: true,
    seen: seenAt(ctx.pr),
  });

  const isViewed = viewed.viewed.has(path);
  const next = useMemo(
    () => nextUnviewed(order, path, viewed.viewed),
    [order, path, viewed.viewed],
  );
  const viewedAndNext = () => {
    if (!isViewed) void viewed.toggle(path);
    if (next) ctx.openTab({ kind: "diff", prId: ctx.pr.id, path: next });
  };

  const sideError = base.error ?? head.error;
  const tooLarge = base.data?.tooLarge || head.data?.tooLarge;
  const binary = file.binary || base.data?.binary || head.data?.binary;
  const ready = (!hasBase || base.data) && (!hasHead || head.data);

  let body: React.ReactNode;
  if (binary) body = <CenteredNote>Binary file — no text diff to show.</CenteredNote>;
  else if (tooLarge) {
    body = (
      <CenteredNote>
        This file is too large to show here ({file.additions} additions, {file.deletions}{" "}
        deletions).
      </CenteredNote>
    );
  } else if (sideError && !ready) body = <CenteredNote tone="error">{sideError}</CenteredNote>;
  else if (!ready) {
    body = (
      <CenteredNote>
        <LoadingIndicator label="Loading file…" />
      </CenteredNote>
    );
  } else {
    body = (
      <MonacoDiffView
        originalUri={modelUri(ctx.prRef, "base", basePath)}
        modifiedUri={modelUri(ctx.prRef, "head", path)}
        path={path}
        original={base.data?.content ?? ""}
        modified={headContent}
        sideBySide={ctx.diffMode === "split"}
        hideUnchanged={!showAll}
        zones={annotations.zones}
        decorations={decorations}
        onLineAction={annotations.onLineAction}
        revealLine={reveal.line}
        revealKey={reveal.key}
        onOpenLocation={onOpenLocation}
      />
    );
  }

  const status = STATUS_LABEL[file.status];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono text-zinc-200" title={path}>
          {file.oldPath ? (
            <>
              <span className="text-zinc-500">{file.oldPath} → </span>
              {path}
            </>
          ) : (
            path
          )}
        </span>
        <span className={status.className}>{status.text}</span>
        {!file.binary && (
          <span className="font-mono">
            <span className="text-emerald-400">+{file.additions}</span>{" "}
            <span className="text-red-400">−{file.deletions}</span>
          </span>
        )}
        {mustRead && <MustReadBadge entry={mustRead} onJump={reveal.jump} />}
        <span className="ml-auto flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1 text-zinc-400">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="h-3.5 w-3.5 accent-sky-500"
            />
            Whole file
          </label>
          {hasHead && (
            <button
              type="button"
              onClick={() => ctx.openTab({ kind: "file", prId: ctx.pr.id, path })}
              className="text-zinc-400 hover:text-zinc-200"
            >
              Open file
            </button>
          )}
          <label className="flex cursor-pointer items-center gap-1 text-zinc-300">
            <input
              type="checkbox"
              checked={isViewed}
              disabled={!viewed.ready}
              onChange={() => void viewed.toggle(path)}
              className="h-3.5 w-3.5 accent-emerald-500"
            />
            Viewed
          </label>
          {next && (
            <button
              type="button"
              onClick={viewedAndNext}
              title={`Mark viewed and open ${next}`}
              className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800"
            >
              {isViewed ? "Next unviewed →" : "Viewed, next →"}
            </button>
          )}
        </span>
      </div>
      {(mustRead || notes.length > 0) && (
        <ReportNotes reason={mustRead?.reason} notes={notes} onJump={reveal.jump} />
      )}
      <AnnotationBar annotations={annotations} error={viewed.error} />
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
}

/**
 * Why the verification report wants this file read, and what its checks
 * found in it, each a click from its line. The same lines are highlighted in
 * the diff.
 */
function ReportNotes({
  reason,
  notes,
  onJump,
}: {
  reason?: string;
  notes: FileNote[];
  onJump: (line: number) => void;
}) {
  return (
    <div className="space-y-0.5 border-b border-amber-900/60 bg-amber-950/30 px-3 py-1 text-xs text-amber-200">
      {reason && <div>{reason}</div>}
      {notes.length > 0 && (
        <ul className="space-y-0.5">
          {notes.map((note) => (
            <li key={`${note.source}:${note.line}:${note.title}`} className="flex gap-2">
              <button
                type="button"
                onClick={() => onJump(note.line)}
                className="shrink-0 font-mono text-sky-400 hover:text-sky-300"
              >
                :{note.line}
              </button>
              <span className="min-w-0 text-zinc-300" title={note.detail || undefined}>
                <span className="text-zinc-500">{note.source}</span>
                {note.severity && <span className="text-zinc-500"> · {note.severity}</span>}{" "}
                {note.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MustReadBadge({
  entry,
  onJump,
}: {
  entry: VerificationMustRead;
  onJump: (line: number) => void;
}) {
  const lines = entry.lines;
  return (
    <button
      type="button"
      disabled={!lines}
      onClick={() => lines && onJump(lines.start)}
      title={entry.reason}
      className="rounded border border-amber-700 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 enabled:hover:bg-amber-900/40"
    >
      Must read{lines ? ` · lines ${lines.start}–${lines.end}` : ""}
    </button>
  );
}
