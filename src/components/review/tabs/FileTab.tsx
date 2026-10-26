import { memo } from "react";
import LoadingIndicator from "../../LoadingIndicator";
import { MonacoFileView } from "../editor";
import { useReviewNavigation } from "../navigation";
import { AnnotationBar, CenteredNote } from "./FileChrome";
import { modelUri, useReviewChangedFiles, useReviewFile } from "./reviewData";
import type { TabContext } from "./types";
import { useFileAnnotations } from "./useFileAnnotations";
import { useReveal } from "./useReveal";

/**
 * Any file at the PR's head, whole, with the PR's threads on it when it has
 * any. Questions work on every file; comments only on the ones the PR changes,
 * which is all a provider takes them on.
 */
export default memo(function FileTab({
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
  const reveal = useReveal(revealLine, revealNonce);
  const { onOpenLocation } = useReviewNavigation(ctx);
  const head = useReviewFile(ctx.workspaceId, ctx.pr, path, "head");
  const changed = useReviewChangedFiles(ctx.workspaceId, ctx.pr);
  const changedFile = changed.data?.files.find((f) => f.path === path);
  const content = head.data?.content ?? "";
  const annotations = useFileAnnotations({
    prRef: ctx.prRef,
    path,
    headContent: content,
    headSha: ctx.pr.headSha ?? "",
    canComment: changedFile !== undefined && changedFile.status !== "deleted",
  });

  let body: React.ReactNode;
  if (!ctx.pr.headSha) body = <CenteredNote>The pull request is still being fetched.</CenteredNote>;
  else if (head.error && !head.data) body = <CenteredNote tone="error">{head.error}</CenteredNote>;
  else if (!head.data) {
    body = (
      <CenteredNote>
        <LoadingIndicator label="Loading file…" />
      </CenteredNote>
    );
  } else if (head.data.binary) body = <CenteredNote>Binary file — nothing to show.</CenteredNote>;
  else if (head.data.tooLarge) {
    body = (
      <CenteredNote>
        This file is too large to show here ({Math.round(head.data.size / 1024)} KB).
      </CenteredNote>
    );
  } else {
    body = (
      <MonacoFileView
        uri={modelUri(ctx.prRef, "head", path)}
        path={path}
        content={content}
        revealLine={reveal.line}
        revealKey={reveal.key}
        onOpenLocation={onOpenLocation}
        zones={annotations.zones}
        onLineAction={annotations.onLineAction}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono text-zinc-200" title={path}>
          {path}
        </span>
        {changedFile && (
          <button
            type="button"
            onClick={() => ctx.openTab({ kind: "diff", prId: ctx.pr.id, path })}
            className="ml-auto text-sky-400 hover:text-sky-300"
          >
            Changed in this PR — open diff
          </button>
        )}
      </div>
      <AnnotationBar annotations={annotations} />
      <div className="relative min-h-0 flex-1">{body}</div>
    </div>
  );
});
