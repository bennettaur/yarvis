import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AgentRunEvent,
  type AgentRunFinalStatus,
  cancelAgentRun,
  streamAgentRun,
} from "../../../lib/agentRuns";
import { usePrDetail } from "../../../lib/pr/cache";
import { getRereviewRunConfig } from "../../../lib/pr/models";
import type { ReviewComment, ReviewThread } from "../../../lib/pr/types";
import { invalidate } from "../../../lib/resourceCache";
import {
  type CommentVerdict,
  type Rereview,
  type RereviewChange,
  type RereviewComment,
  startRereview,
} from "../../../lib/reviewWorkspaces/rereview";
import type { SinceReview } from "../../../lib/reviewWorkspaces/sinceReview";
import { ThreadView, type ThreadViewProps } from "../../pr/ThreadView";
import { useThreadActions } from "../../pr/useThreadActions";
import { Spinner } from "../../ThinkingIndicator";
import { rereviewKey, useLatestRereview, useReviewChangedFiles } from "./reviewData";
import type { TabContext } from "./types";

/**
 * "What's changed": an agent's read of a re-review — whether each of the
 * reviewer's comments was addressed or answered, and which other changes
 * since their review still need them. Everything the agent wrote is shown as
 * plain text, and a path it names is a link only when the PR has that file.
 */

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

export const VERDICT_LABELS: Record<CommentVerdict, { text: string; className: string }> = {
  not_addressed: { text: "Not addressed", className: "border-red-800 text-red-300" },
  partly: { text: "Partly", className: "border-amber-700 text-amber-300" },
  unclear: { text: "Unclear", className: "border-zinc-600 text-zinc-300" },
  disagreed: { text: "Disagreed", className: "border-sky-800 text-sky-300" },
  addressed: { text: "Addressed", className: "border-emerald-800 text-emerald-300" },
};

/** The order "still open" lists its comments in: the clearest problems first. */
const OPEN_ORDER: CommentVerdict[] = ["not_addressed", "partly", "unclear"];

/** The comments in the three groups the summary shows them in. */
export function groupComments(comments: RereviewComment[]): {
  open: RereviewComment[];
  disagreed: RereviewComment[];
  addressed: RereviewComment[];
} {
  const open = comments
    .filter((c) => OPEN_ORDER.includes(c.verdict))
    .sort((a, b) => OPEN_ORDER.indexOf(a.verdict) - OPEN_ORDER.indexOf(b.verdict));
  return {
    open,
    disagreed: comments.filter((c) => c.verdict === "disagreed"),
    addressed: comments.filter((c) => c.verdict === "addressed"),
  };
}

const where = (path: string, line?: number | null) => (line ? `${path}:${line}` : path);

export interface RereviewLinks {
  /** Whether `path` is one of the PR's changed files, so its diff can open. */
  canOpenDiff: (path: string) => boolean;
  openDiff: (path: string, line?: number) => void;
  /** Whether `path` changed since the review, so its interdiff can open. */
  canOpenInterdiff: (path: string) => boolean;
  openInterdiff: (path: string) => void;
}

function PathLink({
  path,
  line,
  canOpen,
  onOpen,
}: {
  path: string;
  line?: number | null;
  canOpen: boolean;
  onOpen: () => void;
}) {
  const label = where(path, line);
  return canOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className="font-mono text-xs text-indigo-300 hover:text-indigo-200"
      title="Open the diff"
    >
      {label}
    </button>
  ) : (
    <span className="font-mono text-xs text-zinc-400">{label}</span>
  );
}

function ConversationComment({ comment }: { comment: ReviewComment }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-2 text-xs">
      <span className="font-medium text-zinc-400">{comment.author}</span>
      <p className="mt-1 whitespace-pre-wrap text-zinc-300">
        {comment.body.length > 400 ? `${comment.body.slice(0, 399)}…` : comment.body}
      </p>
    </div>
  );
}

function CommentItem({
  comment,
  thread,
  conversation,
  threadProps,
  links,
}: {
  comment: RereviewComment;
  thread: ReviewThread | null;
  conversation: ReviewComment | null;
  threadProps: (thread: ReviewThread) => ThreadViewProps;
  links: RereviewLinks;
}) {
  const label = VERDICT_LABELS[comment.verdict];
  const { evidence } = comment;
  const showEvidence =
    evidence.path && (evidence.path !== comment.path || evidence.line !== comment.line);
  return (
    <li className="space-y-2 rounded-lg border border-zinc-800 p-3" data-verdict={comment.verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 text-[11px] ${label.className}`}>
          {label.text}
        </span>
        {comment.path ? (
          <PathLink
            path={comment.path}
            line={comment.line}
            canOpen={links.canOpenDiff(comment.path)}
            onOpen={() => links.openDiff(comment.path as string, comment.line ?? undefined)}
          />
        ) : (
          <span className="text-xs text-zinc-500">On the pull request</span>
        )}
      </div>
      {comment.replySummary && (
        <p className="text-sm text-sky-200">
          <span className="text-zinc-500">Their reason: </span>
          {comment.replySummary}
        </p>
      )}
      {evidence.note && <p className="text-sm text-zinc-300">{evidence.note}</p>}
      {showEvidence && evidence.path && (
        <p className="text-xs text-zinc-500">
          Seen at{" "}
          <PathLink
            path={evidence.path}
            line={evidence.line}
            canOpen={links.canOpenDiff(evidence.path)}
            onOpen={() => links.openDiff(evidence.path as string, evidence.line)}
          />
        </p>
      )}
      {comment.downgradedFrom && (
        <p className="text-xs text-zinc-500">
          The agent said "{VERDICT_LABELS[comment.downgradedFrom].text.toLowerCase()}" but{" "}
          {comment.downgradedFrom === "disagreed" ? "nobody else replied" : "cited no changed code"}
          , so it is shown as unclear.
        </p>
      )}
      {thread ? (
        <ThreadView {...threadProps(thread)} />
      ) : conversation ? (
        <ConversationComment comment={conversation} />
      ) : null}
    </li>
  );
}

function ChangeItem({ change, links }: { change: RereviewChange; links: RereviewLinks }) {
  const lines = change.lines
    ? change.lines.start === change.lines.end
      ? `${change.lines.start}`
      : `${change.lines.start}–${change.lines.end}`
    : null;
  return (
    <li className="flex flex-wrap items-baseline gap-2 text-sm">
      <PathLink
        path={change.path}
        canOpen={links.canOpenInterdiff(change.path)}
        onOpen={() => links.openInterdiff(change.path)}
      />
      {lines && <span className="font-mono text-xs text-zinc-500">lines {lines}</span>}
      <span className="text-zinc-300">{change.reason}</span>
    </li>
  );
}

/**
 * A finished summary: the verdict, the reviewer's comments grouped by what
 * became of them, and the other changes split into what needs reading and
 * what doesn't. Separate from the loading so a test renders it from plain data.
 */
export function RereviewView({
  review,
  threads,
  conversation,
  threadProps,
  links,
}: {
  review: Rereview;
  threads: ReadonlyMap<string, ReviewThread>;
  conversation: ReadonlyMap<string, ReviewComment>;
  threadProps: (thread: ReviewThread) => ThreadViewProps;
  links: RereviewLinks;
}) {
  const groups = groupComments(review.comments);
  const needsReview = review.newChanges.filter((c) => c.kind === "needs_review");
  const minor = review.newChanges.filter((c) => c.kind === "minor");
  const ready = review.verdict === "ready_to_approve";
  const item = (c: RereviewComment) => (
    <CommentItem
      key={c.threadId}
      comment={c}
      thread={c.kind === "thread" ? (threads.get(c.providerId) ?? null) : null}
      conversation={c.kind === "conversation" ? (conversation.get(c.providerId) ?? null) : null}
      threadProps={threadProps}
      links={links}
    />
  );
  return (
    <div className="space-y-4">
      <div
        role="status"
        className={`rounded-lg border p-3 ${
          ready ? "border-emerald-800 bg-emerald-950/30" : "border-amber-800 bg-amber-950/30"
        }`}
      >
        <p className={`text-sm font-semibold ${ready ? "text-emerald-300" : "text-amber-300"}`}>
          {ready ? "Ready to approve" : "Needs another look"}
        </p>
        <p className="text-xs text-zinc-300">{review.verdictReason}</p>
      </div>
      <p className="text-sm text-zinc-200">{review.summary}</p>

      <section aria-label="Your comments" className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Your comments <span className="font-normal">{review.comments.length}</span>
        </h4>
        {review.comments.length === 0 && (
          <p className="text-xs text-zinc-500">You left no comments on this pull request.</p>
        )}
        {groups.open.length > 0 && (
          <>
            <h5 className="text-xs text-zinc-400">Still open ({groups.open.length})</h5>
            <ul className="space-y-2">{groups.open.map(item)}</ul>
          </>
        )}
        {groups.disagreed.length > 0 && (
          <>
            <h5 className="text-xs text-zinc-400">
              Answered with a reason ({groups.disagreed.length})
            </h5>
            <ul className="space-y-2">{groups.disagreed.map(item)}</ul>
          </>
        )}
        {groups.addressed.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-zinc-400">
              Addressed ({groups.addressed.length})
            </summary>
            <ul className="mt-2 space-y-2">{groups.addressed.map(item)}</ul>
          </details>
        )}
      </section>

      <section aria-label="Other changes" className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Other changes <span className="font-normal">{review.newChanges.length}</span>
        </h4>
        {review.newChanges.length === 0 && (
          <p className="text-xs text-zinc-500">
            Nothing changed beyond the fixes for your comments.
          </p>
        )}
        {needsReview.length > 0 && (
          <>
            <h5 className="text-xs text-zinc-400">Needs your review ({needsReview.length})</h5>
            <ul className="space-y-1">
              {needsReview.map((c) => (
                <ChangeItem key={c.path} change={c} links={links} />
              ))}
            </ul>
          </>
        )}
        {minor.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-zinc-400">
              Minor ({minor.length}) — formatting, comments, renames, small fixes
            </summary>
            <ul className="mt-2 space-y-1">
              {minor.map((c) => (
                <ChangeItem key={c.path} change={c} links={links} />
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

/** A run's progress as its events tell it: the latest thing it did, and how it ended. */
export interface RereviewProgress {
  activity: string | null;
  steps: number;
  finished: AgentRunFinalStatus | null;
  error: string | null;
}

export function reduceRereviewProgress(
  progress: RereviewProgress,
  event: AgentRunEvent,
): RereviewProgress {
  switch (event.type) {
    case "tool":
      return {
        ...progress,
        steps: progress.steps + 1,
        activity: event.summary ? `${event.name} ${event.summary}` : event.name,
      };
    case "status":
      return { ...progress, activity: event.message };
    case "error":
      return { ...progress, error: event.message };
    case "done":
      return { ...progress, finished: event.status };
    default:
      return progress;
  }
}

const initialProgress = (): RereviewProgress => ({
  activity: null,
  steps: 0,
  finished: null,
  error: null,
});

/** Follows one run's events to its end, then re-reads the latest summary. */
function useRereviewRun(key: string, runId: string | null): RereviewProgress | null {
  const [progress, setProgress] = useState<RereviewProgress | null>(null);
  useEffect(() => {
    setProgress(runId ? initialProgress() : null);
    if (!runId) return;
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamAgentRun(runId, abort.signal)) {
          setProgress((p) => reduceRereviewProgress(p ?? initialProgress(), event));
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        setProgress((p) => ({
          ...(p ?? initialProgress()),
          error: `Lost track of the run: ${e instanceof Error ? e.message : String(e)}`,
        }));
      }
      if (!abort.signal.aborted) invalidate(key);
    })();
    return () => abort.abort();
  }, [key, runId]);
  return progress;
}

/**
 * The "What's changed" button and what it produces, for the range the
 * "Since last review" tab is showing. Starts by itself only when the setting
 * says so and this range has no summary yet.
 */
export default function RereviewSummary({ ctx, since }: { ctx: TabContext; since: SinceReview }) {
  const { workspaceId, pr } = ctx;
  const from = since.fromHeadSha;
  const key = rereviewKey(pr.id, from);
  const latest = useLatestRereview(workspaceId, pr.id, from);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = latest.data?.run ?? null;
  const runningHere = run?.status === "running" && run.live ? run.id : null;
  const followId = startedId ?? runningHere;
  const progress = useRereviewRun(key, followId);
  const running = followId !== null && progress !== null && progress.finished === null;
  const runningElsewhere = !running && run?.status === "running" && !run.live;
  const good = latest.data?.lastSucceeded ?? null;
  const review = good?.run.result ?? null;

  const start = useCallback(async () => {
    setStarting(true);
    setActionError(null);
    try {
      const { runId } = await startRereview(workspaceId, pr.id, from);
      setStartedId(runId);
      invalidate(key);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [workspaceId, pr.id, from, key]);

  // Auto-start once per range, and only for a range with nothing to show yet.
  const autoStarted = useRef<string | null>(null);
  const loaded = latest.data !== null;
  const covered =
    !!latest.data?.current || !!good?.current || run?.status === "running" || startedId !== null;
  useEffect(() => {
    if (!loaded || covered || autoStarted.current === key) return;
    autoStarted.current = key;
    void getRereviewRunConfig()
      .then((settings) => {
        if (settings.autoStart) void start();
      })
      .catch(() => {
        // Without the setting the button still works; nothing starts by itself.
      });
  }, [loaded, covered, key, start]);

  const { data: detail } = usePrDetail(ctx.prRef);
  const threadList = detail?.reviewThreads ?? [];
  const actions = useThreadActions(ctx.prRef, threadList);
  const threads = useMemo(() => new Map(threadList.map((t) => [t.id, t])), [threadList]);
  const conversation = useMemo(
    () => new Map((detail?.conversation ?? []).map((c) => [c.id, c])),
    [detail?.conversation],
  );
  const changed = useReviewChangedFiles(workspaceId, pr);
  const changedPaths = useMemo(
    () => new Set(changed.data?.files.map((f) => f.path) ?? []),
    [changed.data],
  );
  const sincePaths = useMemo(() => new Set(since.files.map((f) => f.path)), [since.files]);
  const links: RereviewLinks = {
    canOpenDiff: (path) => changedPaths.has(path),
    openDiff: (path, line) =>
      ctx.openTab({ kind: "diff", prId: pr.id, path, ...(line ? { revealLine: line } : {}) }),
    canOpenInterdiff: (path) => sincePaths.has(path),
    openInterdiff: (path) => ctx.openTab({ kind: "since-file", prId: pr.id, path, from }),
  };

  const cancel = async () => {
    if (!followId) return;
    try {
      await cancelAgentRun(followId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const finished = running ? null : run;
  const failed = finished?.status === "failed" && latest.data?.current;
  const notReady = pr.status !== "ready" || pr.worktreeStatus !== "ready";

  return (
    <section
      aria-label="What's changed"
      className="space-y-3 rounded-lg border border-zinc-800 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-200">What's changed</h3>
        {review && good && !running && (
          <span className="text-xs text-zinc-500">
            {short(good.fromHeadSha)}..{short(good.toHeadSha)}
            {good.run.costUsd != null ? ` · $${good.run.costUsd.toFixed(2)}` : ""}
          </span>
        )}
        <span className="ml-auto">
          {running ? (
            <button
              type="button"
              onClick={() => void cancel()}
              className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
          ) : (
            !runningElsewhere && (
              <button
                type="button"
                onClick={() => void start()}
                disabled={starting || notReady}
                className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
              >
                {starting ? "Starting…" : review ? "Re-run" : "What's changed"}
              </button>
            )
          )}
        </span>
      </div>

      {!review && !running && !runningElsewhere && (
        <p className="text-xs text-zinc-400">
          An agent checks whether each of your comments was addressed or answered, and sorts the
          other changes since your review into what needs a look and what is minor.
        </p>
      )}
      {actionError && (
        <p role="alert" className="text-xs text-red-400">
          {actionError}
        </p>
      )}
      {latest.error && <p className="text-xs text-red-400">{latest.error}</p>}

      {running && progress && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Spinner />
          <span>Reading what changed{progress.steps > 0 ? ` · ${progress.steps} steps` : ""}</span>
          {progress.activity && (
            <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
              {progress.activity}
            </span>
          )}
        </div>
      )}
      {runningElsewhere && (
        <p className="text-xs text-zinc-400">
          Another Yarvis window is writing this summary.{" "}
          <button
            type="button"
            onClick={() => void latest.refresh()}
            className="text-sky-400 hover:text-sky-300"
          >
            Check again
          </button>
        </p>
      )}
      {failed && (
        <p role="alert" className="text-xs text-red-300">
          The last run failed: {finished?.error ?? progress?.error ?? "no reason given"}
        </p>
      )}
      {review && good && !good.current && !running && (
        <p className="rounded border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
          This summary covers {short(good.fromHeadSha)}..{short(good.toHeadSha)}, not what this tab
          compares now. Re-run it for the latest changes.
        </p>
      )}

      {review && !running && (
        <RereviewView
          review={review}
          threads={threads}
          conversation={conversation}
          threadProps={(t) => ({ ...actions.viewProps(t), showLocation: false })}
          links={links}
        />
      )}
    </section>
  );
}
