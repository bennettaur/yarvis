import { memo, useState } from "react";
import { refKey } from "../../../lib/pr/ref";
import { type CarriedMode, useSinceReviewFile } from "../../../lib/reviewWorkspaces/sinceReview";
import LoadingIndicator from "../../LoadingIndicator";
import { MonacoDiffView, snapshotUri } from "../editor";
import { useReviewNavigation } from "../navigation";
import { CenteredNote } from "./FileChrome";
import { modelUri } from "./reviewData";
import { SINCE_STATUS } from "./SinceReviewTab";
import type { TabContext } from "./types";

/** What the left side of the diff is, said once above it. */
export const MODE_NOTE: Record<CarriedMode, string> = {
  direct: "Left: the file as you reviewed it. Right: the file now.",
  carried:
    "Left: the file as you reviewed it, moved onto the current base so upstream changes don't show. Right: the file now.",
  "upstream-included":
    "Upstream changed the same lines the PR did, so the left side is the file exactly as you reviewed it — some differences come from the base branch, not the author.",
};

/**
 * One file's change since the last review, as a diff of two whole versions of
 * the file: the version reviewed (carried onto today's base) against today's.
 * A diff of the two diffs would say the same thing, but in a form Monaco can't
 * highlight or fold and a reader has to decode twice; two versions of the file
 * read like any other diff, and differ only where the author did something.
 */
export default memo(function SinceFileTab({
  ctx,
  path,
  from,
}: {
  ctx: TabContext;
  path: string;
  from: string;
}) {
  const view = useSinceReviewFile(ctx.workspaceId, ctx.pr, path, from);
  const [showAll, setShowAll] = useState(false);
  const { onOpenLocation } = useReviewNavigation(ctx);

  if (!ctx.pr.headSha) return <CenteredNote>The pull request is still being fetched.</CenteredNote>;
  if (view.error && !view.data) return <CenteredNote tone="error">{view.error}</CenteredNote>;
  if (!view.data) {
    return (
      <CenteredNote>
        <LoadingIndicator label="Comparing with your review…" />
      </CenteredNote>
    );
  }
  const data = view.data;
  const status = SINCE_STATUS[data.status];
  const unreadable =
    data.tooLarge || data.original?.binary || data.modified?.binary || data.original?.tooLarge;
  const key = refKey(ctx.prRef);
  // The reviewed version depends on the reviewed head and today's merge-base.
  const originalUri = snapshotUri(key, `since-${from}-${ctx.pr.mergeBaseSha ?? ""}`, path);
  // A file the PR has stopped changing reads at today's head under its base
  // name, which needn't be `path`, so it gets a model of its own.
  const modifiedUri =
    data.status === "reverted"
      ? snapshotUri(key, `head-${data.toHeadSha}`, path)
      : modelUri(ctx.prRef, "head", path);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-3 py-1.5 text-xs">
        <span className="min-w-0 truncate font-mono text-zinc-200" title={path}>
          {path}
        </span>
        <span className={status.className}>{status.text} since your review</span>
        {!unreadable && (
          <span className="font-mono">
            <span className="text-emerald-400">+{data.additions}</span>{" "}
            <span className="text-red-400">−{data.deletions}</span>
          </span>
        )}
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
          {data.status !== "reverted" && (
            <button
              type="button"
              onClick={() => ctx.openTab({ kind: "diff", prId: ctx.pr.id, path })}
              title="The whole change this PR makes to the file"
              className="text-zinc-400 hover:text-zinc-200"
            >
              Full PR diff
            </button>
          )}
        </span>
      </div>
      <p
        className={`border-b border-zinc-800 px-3 py-1 text-xs ${
          data.mode === "upstream-included" ? "bg-amber-950/30 text-amber-200" : "text-zinc-500"
        }`}
      >
        {MODE_NOTE[data.mode]}
      </p>
      <div className="relative min-h-0 flex-1">
        {unreadable ? (
          <CenteredNote>This file is binary or too large to compare here.</CenteredNote>
        ) : !data.patch ? (
          <CenteredNote>
            No difference once upstream changes are set aside: the author's change to this file is
            the same as before.
          </CenteredNote>
        ) : (
          <MonacoDiffView
            originalUri={originalUri}
            modifiedUri={modifiedUri}
            path={path}
            original={data.original?.content ?? ""}
            modified={data.modified?.content ?? ""}
            sideBySide={ctx.diffMode === "split"}
            hideUnchanged={!showAll}
            onOpenLocation={onOpenLocation}
          />
        )}
      </div>
    </div>
  );
});
