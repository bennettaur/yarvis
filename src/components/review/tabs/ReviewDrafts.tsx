import { useState } from "react";
import { invalidate, prDetailKey } from "../../../lib/pr/cache";
import { primeCache } from "../../../lib/resourceCache";
import {
  answerReviewDraft,
  type DraftAnswer,
  draftText,
  postReviewDrafts,
  type ReviewDraft,
  type ReviewDrafts,
} from "../../../lib/reviewWorkspaces/drafts";
import { invalidateLastReview, seenAt } from "../../../lib/reviewWorkspaces/sinceReview";
import Markdown from "../../Markdown";
import type { TabContext } from "./types";

const BUTTON =
  "rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";

export interface DraftActions {
  answer: (draft: ReviewDraft, answer: DraftAnswer) => Promise<boolean>;
  /** Resolves true when everything accepted went up. */
  post: (summary: string) => Promise<boolean>;
  busy: boolean;
  error: string | null;
  notice: string | null;
}

/**
 * Answers and posting for one PR's drafts. An answer is written into the
 * cached list straight away, so the diff and the bar agree without a reload.
 */
export function useDraftActions(
  ctx: TabContext,
  key: string,
  refresh: () => Promise<void>,
): DraftActions {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const answer = async (draft: ReviewDraft, a: DraftAnswer) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await answerReviewDraft(ctx.workspaceId, ctx.pr.id, draft.id, a);
      primeCache<ReviewDrafts>(key, (current) => ({
        headSha: current?.headSha ?? ctx.pr.headSha,
        drafts: (current?.drafts ?? []).map((d) => (d.id === updated.id ? updated : d)),
      }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const post = async (summary: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await postReviewDrafts(ctx.workspaceId, ctx.pr.id, summary, seenAt(ctx.pr));
      if (result.error) {
        setError(`${result.posted} posted, then: ${result.error}`);
        return false;
      }
      setNotice(`Posted ${result.posted} comment${result.posted === 1 ? "" : "s"}.`);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      // Whatever went up shows on the PR, even when the rest didn't.
      invalidate(prDetailKey(ctx.prRef));
      invalidateLastReview(ctx.prRef);
      await refresh();
      setBusy(false);
    }
  };

  return { answer, post, busy, error, notice };
}

/**
 * A draft hanging under its line: dashed and violet so it can't be taken for
 * a posted thread, labelled with what proposed it. Its text is model-written,
 * so it renders through the same markdown as comments, which never renders HTML.
 */
export function DraftBlock({ draft, actions }: { draft: ReviewDraft; actions: DraftActions }) {
  const [editing, setEditing] = useState<string | null>(null);
  const accepted = draft.status === "accepted";

  return (
    <div className="my-1 rounded border border-dashed border-violet-700 bg-violet-950/20 p-2 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded bg-violet-900/60 px-1.5 py-0.5 font-medium text-violet-200">
          Draft
        </span>
        <span className="text-zinc-400">
          {draft.label} · {draft.source}
        </span>
        {accepted && (
          <span className="text-emerald-400">
            Accepted{draft.outcome === "edited" ? ", edited" : ""}. Posts with the review.
          </span>
        )}
      </div>
      {editing !== null ? (
        <>
          <textarea
            aria-label="Draft comment"
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            className="h-28 w-full rounded-md border border-zinc-700 bg-zinc-800 p-2 text-sm text-zinc-100"
          />
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              disabled={actions.busy || !editing.trim()}
              onClick={async () => {
                if (await actions.answer(draft, { action: "accept", body: editing })) {
                  setEditing(null);
                }
              }}
              className="rounded-md bg-violet-700 px-3 py-1 text-xs text-white hover:bg-violet-600 disabled:opacity-50"
            >
              Save and accept
            </button>
            <button type="button" onClick={() => setEditing(null)} className={BUTTON}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <Markdown>{draftText(draft)}</Markdown>
          <div className="mt-1 flex gap-2">
            {accepted ? (
              <button
                type="button"
                disabled={actions.busy}
                onClick={() => void actions.answer(draft, { action: "reopen" })}
                className={BUTTON}
              >
                Undo
              </button>
            ) : (
              <button
                type="button"
                disabled={actions.busy}
                onClick={() => void actions.answer(draft, { action: "accept" })}
                className={BUTTON}
              >
                Accept
              </button>
            )}
            <button
              type="button"
              disabled={actions.busy}
              onClick={() => setEditing(draftText(draft))}
              className={BUTTON}
            >
              Edit
            </button>
            <button
              type="button"
              disabled={actions.busy}
              onClick={() => void actions.answer(draft, { action: "drop" })}
              className={BUTTON}
            >
              Drop
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The PR's drafts at a glance: how many are left to answer, posting the
 * accepted ones as one review, and the stale ones, whose finding the latest
 * verification no longer reports.
 */
export function DraftsBar({
  ctx,
  drafts,
  actions,
  onJump,
}: {
  ctx: TabContext;
  drafts: readonly ReviewDraft[];
  actions: DraftActions;
  onJump: (draft: ReviewDraft) => void;
}) {
  const [summary, setSummary] = useState("");
  const current = drafts.filter((d) => !d.stale && d.headSha === ctx.pr.headSha);
  const open = current.filter((d) => d.status === "open");
  const accepted = current.filter((d) => d.status === "accepted");
  const stale = drafts.filter((d) => d.stale && (d.status === "open" || d.status === "accepted"));
  if (open.length + accepted.length + stale.length === 0 && !actions.notice && !actions.error) {
    return null;
  }
  const github = ctx.prRef.provider === "github";

  return (
    <div className="space-y-1 border-b border-violet-900/60 bg-violet-950/20 px-3 py-1 text-xs text-zinc-300">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-violet-200">Draft comments</span>
        <span>
          {open.length} to answer · {accepted.length} accepted
        </span>
        {accepted.length > 0 && (
          <>
            {github && (
              <input
                aria-label="Review summary"
                placeholder="Review summary (optional)"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                className="min-w-40 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-100"
              />
            )}
            <button
              type="button"
              disabled={actions.busy}
              onClick={async () => {
                if (await actions.post(summary)) setSummary("");
              }}
              className="rounded bg-violet-700 px-2 py-0.5 text-xs text-white hover:bg-violet-600 disabled:opacity-50"
            >
              {github
                ? `Post ${accepted.length} as one review`
                : `Post ${accepted.length} comment${accepted.length === 1 ? "" : "s"}`}
            </button>
          </>
        )}
      </div>
      {stale.length > 0 && (
        <ul className="space-y-0.5">
          {stale.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 text-zinc-400">
              <span className="text-amber-400">Stale</span>
              <button
                type="button"
                onClick={() => onJump(d)}
                className="font-mono text-sky-400 hover:text-sky-300"
              >
                {d.path}:{d.line}
              </button>
              <span className="min-w-0 truncate" title={draftText(d)}>
                {d.title}
                {d.editedBody !== null ? " (edited)" : ""}
              </span>
              <button
                type="button"
                disabled={actions.busy}
                onClick={() => void actions.answer(d, { action: "drop" })}
                className={BUTTON}
              >
                Drop
              </button>
            </li>
          ))}
        </ul>
      )}
      {actions.error && (
        <p role="alert" className="text-red-400">
          {actions.error}
        </p>
      )}
      {actions.notice && (
        <p role="status" className="text-emerald-400">
          {actions.notice}
        </p>
      )}
    </div>
  );
}
