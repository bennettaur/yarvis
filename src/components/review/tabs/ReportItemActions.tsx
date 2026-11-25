import { useState } from "react";
import type { CommentPlacement } from "../../../lib/pr/types";
import {
  type FeedbackAction,
  type FeedbackInput,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackRating,
  feedbackItemKey,
  type ReportFeedback,
} from "../../../lib/reviewWorkspaces/feedback";
import type { ReportSection, Severity } from "../../../lib/reviewWorkspaces/verification";

/**
 * Where a finding can be sent once the reviewer has read it. Each takes the
 * finding and the label of the section it came from, and only findings with a
 * path and line get the buttons, since both targets anchor to a line.
 */
export interface FindingPoster {
  /** "file" when GitHub put the comment on the whole file instead of its line. */
  toPr: (finding: Located, section: string) => Promise<CommentPlacement | undefined>;
  /** Present when the PR was raised from a Yarvis workspace. */
  toWorkspace?: { name: string; add: (finding: Located, section: string) => Promise<void> };
}

/** A finding or concern with the location both comment targets need. */
export interface Located {
  title: string;
  detail: string;
  severity?: Severity;
  path: string;
  line: number;
}

/** What a follow-up question is about: the lines, and the report item as text. */
export interface AskTarget {
  path: string;
  startLine: number;
  endLine: number;
  about: string;
}

/**
 * The reviewer's feedback on the report, read and written per item. Each
 * section's items are keyed to the run whose result the report shows.
 */
export interface FeedbackController {
  /** The run whose result a section shows; null when it has none. */
  runFor: (section: ReportSection) => string | null;
  get: (section: ReportSection, runId: string, itemKey: string) => ReportFeedback | undefined;
  save: (input: FeedbackInput) => Promise<void>;
}

/** Everything a report item can do besides being read. Each part is absent where it can't work. */
export interface ReportActions {
  poster?: FindingPoster;
  /** Asks about the item's lines and resolves to the answer. */
  ask?: (target: AskTarget, question: string) => Promise<string>;
  feedback?: FeedbackController;
}

type PostState = "posting" | "posted" | "posted-to-file" | { error: string };

const BUTTON =
  "rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-60";

const RATING_LABEL: Record<FeedbackRating, string> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
};

type Verdict = Pick<ReportFeedback, "verdict" | "rating" | "reason">;

function verdictText(feedback: Verdict, acceptLabel: string): string {
  switch (feedback.verdict) {
    case "accepted":
      return acceptLabel === "Accept risk" ? "You accepted this risk" : "You agreed";
    case "rejected":
      return "You rejected this";
    case "rerated":
      return `You rated it ${feedback.rating ?? "differently"}`;
    default:
      return "";
  }
}

/**
 * The actions under one report item: send it to the PR or workspace, ask a
 * follow-up about it, and say whether it was right. A rejection or a new
 * rating asks why, and the answer is kept for the weekly review reflection,
 * as is everything the reviewer did with the item.
 */
export function ItemActions({
  section,
  sectionLabel,
  kind,
  item,
  lines,
  actions,
  canPost = true,
  acceptLabel = "Agree",
  ratings,
}: {
  section: ReportSection;
  /** How the section is named on a posted comment. */
  sectionLabel: string;
  kind: FeedbackKind;
  item: FeedbackItem & { severity?: Severity };
  /** The lines a follow-up asks about, when the item covers more than one. */
  lines?: { start: number; end: number };
  actions?: ReportActions;
  /** False where the item isn't something to put to the author, such as a verified claim. */
  canPost?: boolean;
  /** "Accept risk" for a risk, "Agree" for a finding. */
  acceptLabel?: string;
  /** The ratings a reviewer can move the item to; absent when it has none. */
  ratings?: readonly FeedbackRating[];
}) {
  const [toPr, setToPr] = useState<PostState | null>(null);
  const [toWorkspace, setToWorkspace] = useState<PostState | null>(null);
  const [mode, setMode] = useState<null | "reject" | "rerate" | "ask">(null);
  const [reason, setReason] = useState("");
  const [rating, setRating] = useState<FeedbackRating | "">("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // What was just saved, shown before the saved list comes back round.
  const [justSaved, setJustSaved] = useState<(Verdict & { runId: string }) | null>(null);

  const feedback = actions?.feedback;
  const runId = feedback?.runFor(section) ?? null;
  const itemKey = feedbackItemKey(kind, item);
  const savedFeedback = runId ? feedback?.get(section, runId, itemKey) : undefined;
  // A newer run's item is a new item, whatever the reviewer said about the old one.
  const current: Verdict | undefined =
    justSaved && justSaved.runId === runId ? justSaved : savedFeedback;
  const { path, line } = item;
  const poster = canPost && path && line ? actions?.poster : undefined;
  const ask = path ? actions?.ask : undefined;
  if (!poster && !ask && !(feedback && runId)) return null;

  const { severity: _, ...stored } = item;
  const save = async (
    change: Omit<FeedbackInput, "runId" | "section" | "kind" | "itemKey" | "item">,
  ) => {
    if (!feedback || !runId) return;
    await feedback.save({ runId, section, kind, itemKey, item: stored, ...change });
  };
  // What the reviewer did is worth keeping, but failing to keep it mustn't undo the action.
  const record = (action: FeedbackAction) =>
    void save({ action }).catch((e) =>
      console.warn("[verification] could not record what was done with an item:", e),
    );

  const send = async (
    fn: () => Promise<unknown>,
    set: (s: PostState) => void,
    action: FeedbackAction,
  ) => {
    set("posting");
    try {
      set((await fn()) === "file" ? "posted-to-file" : "posted");
      record(action);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const postButton = (state: PostState | null, idle: string, done: string, onClick: () => void) => {
    const sent = state === "posted" || state === "posted-to-file";
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={state === "posting" || sent}
        className={BUTTON}
      >
        {state === "posting" ? "Posting…" : sent ? done : idle}
      </button>
    );
  };

  const submitVerdict = async (change: Parameters<typeof save>[0]) => {
    setSaving(true);
    setError(null);
    try {
      await save(change);
      if (change.verdict !== undefined) {
        setJustSaved({
          runId: runId as string,
          verdict: change.verdict,
          rating: change.rating ?? null,
          reason: change.reason || null,
        });
      }
      setMode(null);
      setReason("");
      setRating("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const submitQuestion = async () => {
    if (!ask || !path || !question.trim()) return;
    setAsking(true);
    setError(null);
    const start = lines?.start ?? line ?? 1;
    try {
      const reply = await ask(
        {
          path,
          startLine: start,
          endLine: Math.max(start, lines?.end ?? start),
          about: `${sectionLabel}: ${item.title}\n${item.detail}`,
        },
        question.trim(),
      );
      setAnswer(reply);
      setQuestion("");
      setMode(null);
      record("asked");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(false);
    }
  };

  const located: Located | null =
    path && line
      ? {
          title: item.title,
          detail: item.detail,
          ...(item.severity && { severity: item.severity }),
          path,
          line,
        }
      : null;
  const workspace = poster?.toWorkspace;
  const postErrors = [toPr, toWorkspace].flatMap((s) =>
    s && typeof s === "object" ? [s.error] : [],
  );
  const canJudge = !!feedback && !!runId;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {poster &&
          located &&
          postButton(
            toPr,
            "Post to PR",
            "Posted to PR",
            () => void send(() => poster.toPr(located, sectionLabel), setToPr, "posted-pr"),
          )}
        {workspace &&
          located &&
          postButton(
            toWorkspace,
            `Add to ${workspace.name}`,
            `Added to ${workspace.name}`,
            () =>
              void send(
                () => workspace.add(located, sectionLabel),
                setToWorkspace,
                "added-workspace",
              ),
          )}
        {ask && (
          <button
            type="button"
            onClick={() => setMode(mode === "ask" ? null : "ask")}
            className={BUTTON}
          >
            Ask a follow-up
          </button>
        )}
        {canJudge && current?.verdict ? (
          <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
            <span
              className={
                current.verdict === "rejected"
                  ? "text-red-300"
                  : current.verdict === "accepted"
                    ? "text-emerald-300"
                    : "text-amber-300"
              }
            >
              {verdictText(current, acceptLabel)}
            </span>
            {current.reason && <span className="text-zinc-500">“{current.reason}”</span>}
            <button
              type="button"
              onClick={() => void submitVerdict({ verdict: null })}
              disabled={saving}
              className="text-sky-400 hover:text-sky-300 disabled:opacity-60"
            >
              Undo
            </button>
          </span>
        ) : (
          canJudge && (
            <span className="flex items-center gap-1.5 border-l border-zinc-800 pl-1.5">
              <button
                type="button"
                onClick={() => void submitVerdict({ verdict: "accepted" })}
                disabled={saving}
                title="This is right. Kept for the weekly review reflection."
                className={BUTTON}
              >
                {acceptLabel}
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === "reject" ? null : "reject")}
                title="This is wrong or not useful. Say why; the weekly review reflection reads it."
                className={BUTTON}
              >
                Reject…
              </button>
              {ratings && (
                <button
                  type="button"
                  onClick={() => setMode(mode === "rerate" ? null : "rerate")}
                  title="Right, but rated too high or too low."
                  className={BUTTON}
                >
                  Change rating…
                </button>
              )}
            </span>
          )
        )}
      </div>

      {mode === "reject" && (
        <form
          className="flex flex-wrap items-start gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submitVerdict({ verdict: "rejected", reason });
          }}
        >
          <textarea
            aria-label="Why this is wrong"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this wrong or not useful? The weekly review reflection reads this to improve the checks."
            rows={2}
            className="min-w-[16rem] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
          />
          <button type="submit" disabled={saving} className={BUTTON}>
            {saving ? "Saving…" : "Reject"}
          </button>
          <button type="button" onClick={() => setMode(null)} className={BUTTON}>
            Cancel
          </button>
        </form>
      )}

      {mode === "rerate" && ratings && (
        <form
          className="flex flex-wrap items-start gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (rating) void submitVerdict({ verdict: "rerated", rating, reason });
          }}
        >
          <select
            aria-label="New rating"
            value={rating}
            onChange={(e) => setRating(e.target.value as FeedbackRating | "")}
            className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-300"
          >
            <option value="">Rate it…</option>
            {ratings
              .filter((r) => r !== item.rating)
              .map((r) => (
                <option key={r} value={r}>
                  {RATING_LABEL[r]}
                </option>
              ))}
          </select>
          <input
            aria-label="Why the rating is off"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? (optional)"
            className="min-w-[12rem] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
          />
          <button type="submit" disabled={saving || !rating} className={BUTTON}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setMode(null)} className={BUTTON}>
            Cancel
          </button>
        </form>
      )}

      {mode === "ask" && (
        <form
          className="flex flex-wrap items-start gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submitQuestion();
          }}
        >
          <input
            aria-label="Follow-up question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this, e.g. is it real, and how would you fix it?"
            className="min-w-[16rem] flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600"
          />
          <button type="submit" disabled={asking || !question.trim()} className={BUTTON}>
            {asking ? "Asking…" : "Ask"}
          </button>
        </form>
      )}

      {answer && (
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-300">
          <div className="mb-0.5 text-[10px] text-zinc-500">
            Answer, also kept beside the code in the diff
          </div>
          <p className="whitespace-pre-wrap">{answer}</p>
        </div>
      )}

      {toPr === "posted-to-file" && (
        <span role="status" className="text-[10px] text-amber-300">
          Posted on the whole file instead: GitHub only takes line comments on lines inside the
          diff.
        </span>
      )}
      {[...postErrors, ...(error ? [error] : [])].map((e) => (
        <span key={e} role="alert" className="block text-[10px] text-red-400">
          {e}
        </span>
      ))}
    </div>
  );
}
