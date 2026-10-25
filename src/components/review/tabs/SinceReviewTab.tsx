import { memo, type ReactNode, useState } from "react";
import { refProviderName } from "../../../lib/pr/ref";
import type { PrRef } from "../../../lib/pr/types";
import {
  invalidateLastReview,
  markReviewedHere,
  type ReviewCommit,
  type ReviewMark,
  type SinceFile,
  type SinceReview,
  useLastReview,
  useSinceReview,
} from "../../../lib/reviewWorkspaces/sinceReview";
import { formatRelativeTime } from "../../../lib/time";
import LoadingIndicator from "../../LoadingIndicator";
import { CenteredNote } from "./FileChrome";
import RereviewSummary from "./RereviewSummary";
import { TabPage } from "./StaticTabs";
import type { TabContext } from "./types";

const short = (sha: string) => sha.slice(0, 7);

/** How a mark came about, in a phrase that follows "You reviewed …". */
export function markSourceText(mark: ReviewMark, ref: PrRef): string {
  switch (mark.source) {
    case "review":
      return "when you submitted a review here";
    case "comment":
      return "when you commented here";
    case "manual":
      return "when you marked it reviewed";
    case "provider":
      return `in your review on ${refProviderName(ref)}`;
  }
}

export const SINCE_STATUS: Record<SinceFile["status"], { text: string; className: string }> = {
  added: { text: "Newly changed", className: "text-emerald-400" },
  modified: { text: "Changed again", className: "text-amber-400" },
  reverted: { text: "Reverted", className: "text-sky-400" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 new commits · 2 files changed · rebased onto a newer base". */
export function summaryLine(since: SinceReview): string {
  const fresh = since.commits.filter((c) => c.isNew).length;
  const parts = [plural(fresh, "new commit"), `${plural(since.files.length, "file")} changed`];
  if (since.rebased && since.baseMoved) parts.push("rebased onto a newer base");
  else if (since.rebased) parts.push("history rewritten (force-push)");
  else if (since.baseMoved) parts.push("base branch merged in");
  return parts.join(" · ");
}

function CommitRow({
  commit,
  onOpen,
  removed,
}: {
  commit: ReviewCommit;
  onOpen?: () => void;
  removed?: boolean;
}) {
  const body = (
    <>
      <span className="shrink-0 font-mono text-zinc-500">{short(commit.sha)}</span>
      <span className={`min-w-0 flex-1 truncate ${removed ? "line-through" : ""}`}>
        {commit.subject}
      </span>
      {commit.rebasedFrom && (
        <span className="shrink-0 text-zinc-500" title={`Same change as ${commit.rebasedFrom}`}>
          rebased
        </span>
      )}
      <span className="shrink-0 text-zinc-500">{commit.author}</span>
      <span className="shrink-0 text-zinc-600">{formatRelativeTime(commit.date)}</span>
    </>
  );
  const className = `flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs ${
    commit.isNew ? "bg-emerald-950/30 text-zinc-100" : "text-zinc-400"
  }`;
  return onOpen ? (
    <button type="button" onClick={onOpen} className={`${className} hover:bg-zinc-800`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * What the tab shows once both reads are in: the mark, the summary line, the
 * agent's "What's changed" summary (`summary`), the files whose PR-only change
 * differs, and the commits. Separate from the loading so it renders in a test
 * from plain data.
 */
export function SinceReviewView({
  prRef,
  since,
  summary,
  onOpenFile,
  onOpenCommit,
}: {
  prRef: PrRef;
  since: SinceReview;
  summary?: ReactNode;
  onOpenFile: (file: SinceFile) => void;
  onOpenCommit: (commit: ReviewCommit) => void;
}) {
  const mark = since.mark;
  const fresh = since.commits.filter((c) => c.isNew);
  return (
    <>
      <header className="space-y-1">
        <h2 className="text-base font-semibold text-zinc-100">Since your last review</h2>
        <p className="text-xs text-zinc-400">
          You reviewed <span className="font-mono">{short(since.fromHeadSha)}</span>{" "}
          {markSourceText(mark, prRef)} {formatRelativeTime(mark.createdAt)}; the checkout is at{" "}
          <span className="font-mono">{short(since.toHeadSha)}</span>.
        </p>
        <p className="text-sm text-zinc-200" data-testid="since-summary">
          {summaryLine(since)}
        </p>
        {since.baseMoved && (
          <p className="text-xs text-zinc-500">
            Changes that came in from the base branch are left out: each file compares the PR's own
            change then and now.
          </p>
        )}
      </header>

      {summary}

      <section aria-label="Files changed since your review" className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Files{" "}
          {since.files.length > 0 && <span className="font-normal">{since.files.length}</span>}
        </h3>
        {since.files.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No file's change differs from what you reviewed
            {since.baseMoved ? " (only upstream changes came in)" : ""}.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {since.files.map((file) => {
              const status = SINCE_STATUS[file.status];
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onOpenFile(file)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-zinc-800"
                  >
                    <span className={`w-24 shrink-0 ${status.className}`}>{status.text}</span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-zinc-200"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                    {file.binary || file.tooLarge ? (
                      <span className="text-zinc-500">{file.binary ? "binary" : "too large"}</span>
                    ) : (
                      <span className="shrink-0 font-mono">
                        <span className="text-emerald-400">+{file.additions}</span>{" "}
                        <span className="text-red-400">−{file.deletions}</span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {since.filesTruncated && (
          <p className="text-xs text-zinc-500">Line counts stop after the first 300 files.</p>
        )}
      </section>

      <section aria-label="Commits since your review" className="space-y-1">
        <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          New commits <span className="font-normal">{fresh.length}</span>
        </h3>
        {fresh.length === 0 ? (
          <p className="text-xs text-zinc-500">None — the commits are the ones you saw.</p>
        ) : (
          fresh.map((c) => <CommitRow key={c.sha} commit={c} onOpen={() => onOpenCommit(c)} />)
        )}
        {since.removedCommits.length > 0 && (
          <>
            <h3 className="pt-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Gone since your review{" "}
              <span className="font-normal">{since.removedCommits.length}</span>
            </h3>
            {since.removedCommits.map((c) => (
              <CommitRow key={c.sha} commit={c} removed />
            ))}
          </>
        )}
        {since.commitsTruncated && (
          <p className="text-xs text-zinc-500">Only the newest 250 commits are listed.</p>
        )}
        {since.rebaseMatchSkipped && (
          <p className="text-xs text-zinc-500">
            Too many commits to match rebased ones to those you reviewed, so every rewritten commit
            counts as new.
          </p>
        )}
      </section>
    </>
  );
}

/** The "Since last review" tab: what the PR's own change did since the user last reviewed it. */
export default memo(function SinceReviewTab({ ctx }: { ctx: TabContext }) {
  const last = useLastReview(ctx.workspaceId, ctx.pr);
  const mark = last.data?.mark ?? null;
  const usable = mark && last.data?.shaExists !== false && !last.data?.upToDate;
  const since = useSinceReview(ctx.workspaceId, ctx.pr, usable ? mark.headSha : null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const markHere = async () => {
    setMarking(true);
    setMarkError(null);
    try {
      await markReviewedHere(ctx.workspaceId, ctx.pr.id);
      invalidateLastReview(ctx.prRef);
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarking(false);
    }
  };
  const markButton = (
    <button
      type="button"
      disabled={marking || !ctx.pr.headSha}
      onClick={() => void markHere()}
      className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
    >
      {marking ? "Marking…" : "Mark reviewed here"}
    </button>
  );

  if (!ctx.pr.headSha) return <CenteredNote>The pull request is still being fetched.</CenteredNote>;
  const error = last.error ?? since.error;
  if (error && !(last.data && (since.data || !usable))) {
    return <CenteredNote tone="error">{error}</CenteredNote>;
  }
  if (!last.data || (usable && !since.data)) {
    return (
      <CenteredNote>
        <LoadingIndicator label="Comparing with your last review…" />
      </CenteredNote>
    );
  }
  if (!mark || !usable) {
    let note: string;
    if (!mark) {
      note =
        "No review of this pull request is recorded yet. Submitting a review, posting a comment, or marking it reviewed here records where you were.";
    } else if (last.data.shaExists === false) {
      note = `The commit you reviewed (${short(mark.headSha)}) can no longer be fetched, so there is nothing to compare with.`;
    } else {
      note = `Nothing has changed since you reviewed ${short(mark.headSha)}.`;
    }
    return (
      <TabPage>
        <h2 className="text-base font-semibold text-zinc-100">Since your last review</h2>
        <p className="text-sm text-zinc-400">{note}</p>
        {mark?.headSha !== ctx.pr.headSha && markButton}
        {markError && <p className="text-xs text-red-400">{markError}</p>}
      </TabPage>
    );
  }
  const data = since.data as SinceReview;
  return (
    <TabPage>
      <SinceReviewView
        prRef={ctx.prRef}
        since={data}
        summary={<RereviewSummary key={data.fromHeadSha} ctx={ctx} since={data} />}
        onOpenFile={(file) =>
          ctx.openTab({
            kind: "since-file",
            prId: ctx.pr.id,
            path: file.path,
            from: data.fromHeadSha,
          })
        }
        onOpenCommit={(commit) =>
          ctx.openTab({ kind: "commit", prId: ctx.pr.id, sha: commit.sha, subject: commit.subject })
        }
      />
      <div className="flex items-center gap-2 border-t border-zinc-800 pt-3">
        {markButton}
        <span className="text-xs text-zinc-500">
          Done catching up? Marking moves the starting point to this checkout.
        </span>
      </div>
      {markError && <p className="text-xs text-red-400">{markError}</p>}
    </TabPage>
  );
});
