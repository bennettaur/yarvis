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
type VerdictChange = Pick<FeedbackInput, "verdict" | "rating" | "reason">;

const BUTTON =
  "rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-60";
const INPUT =
  "rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600";

/** What the feedback is for, said once so the buttons' hints agree. */
const FEEDBACK_PURPOSE = "Saved so the checks can be tuned from what you thought of them.";

const RATING_LABEL: Record<FeedbackRating, string> = {
  none: "No risk",
  low: "Low",
  medium: "Medium",
  high: "High",
};

const VERDICT_CLASS: Record<NonNullable<ReportFeedback["verdict"]>, string> = {
  accepted: "text-emerald-300",
  rejected: "text-red-300",
  rerated: "text-amber-300",
};

/**
 * The actions under one report item: send it to the PR or workspace, ask a
 * follow-up about it, and say whether it was right. A rejection asks why, and
 * the answer is kept with the item, as is everything the reviewer did with it,
 * so the checks can be tuned from it.
 */
export function ReportItemActions({
  section,
  sectionLabel,
  kind,
  item,
  lines,
  actions,
  canPost = true,
  risk = false,
  ratings,
}: {
  /** The report section whose run the item came from. */
  section: ReportSection;
  /** How the section is named on a posted comment and in a follow-up question. */
  sectionLabel: string;
  kind: FeedbackKind;
  /** `rating` is the item's own rating as the report shows it: context for the feedback, not one of `ratings`. */
  item: FeedbackItem & { severity?: Severity };
  /** The lines a follow-up asks about, when the item covers more than one. */
  lines?: { start: number; end: number };
  actions?: ReportActions;
  /** False where the item isn't something to put to the author, such as a verified claim. */
  canPost?: boolean;
  /** A risk the reviewer accepts, rather than a finding they agree with. */
  risk?: boolean;
  /** The ratings a reviewer can move the item to; absent when it has none. */
  ratings?: readonly FeedbackRating[];
}) {
  const [toPr, setToPr] = useState<PostState | null>(null);
  const [toWorkspace, setToWorkspace] = useState<PostState | null>(null);
  const [form, setForm] = useState<null | "reject" | "rerate" | "ask">(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const feedback = actions?.feedback;
  const runId = feedback?.runFor(section) ?? null;
  const judge = feedback && runId ? { feedback, runId } : null;
  const itemKey = feedbackItemKey(kind, item);
  const shown = judge?.feedback.get(section, judge.runId, itemKey);
  const { path, line } = item;
  const poster = canPost && path && line ? actions?.poster : undefined;
  const ask = path ? actions?.ask : undefined;
  if (!poster && !ask && !judge) return null;

  // Severity only shapes a posted comment; the stored item carries it as `rating`.
  const { severity: _severity, ...storedItem } = item;
  const save = async (
    change: Omit<FeedbackInput, "runId" | "section" | "kind" | "itemKey" | "item">,
  ) => {
    if (!judge) return;
    await judge.feedback.save({
      runId: judge.runId,
      section,
      kind,
      itemKey,
      item: storedItem,
      ...change,
    });
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

  /** Saves a verdict; rethrows so a form can keep what was typed. */
  const submitVerdict = async (change: VerdictChange) => {
    setSaving(true);
    setError(null);
    try {
      await save(change);
      setForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  };

  const submitQuestion = async (question: string) => {
    if (!ask || !path) return;
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
        question,
      );
      setAnswer(reply);
      setForm(null);
      record("asked");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
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
  const toggle = (next: NonNullable<typeof form>) => setForm(form === next ? null : next);

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
          <button type="button" onClick={() => toggle("ask")} className={BUTTON}>
            Ask a follow-up
          </button>
        )}
        {judge &&
          (shown?.verdict ? (
            <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-400">
              <span className={VERDICT_CLASS[shown.verdict]}>{verdictText(shown, risk)}</span>
              {shown.reason && <span className="text-zinc-500">“{shown.reason}”</span>}
              <button
                type="button"
                onClick={() => void submitVerdict({ verdict: null }).catch(() => {})}
                disabled={saving}
                title="Take back what you said. Anything posted stays posted."
                className="text-sky-400 hover:text-sky-300 disabled:opacity-60"
              >
                Undo
              </button>
            </span>
          ) : (
            <fieldset
              aria-label="Was this right?"
              className="flex items-center gap-1.5 border-0 border-l border-zinc-800 p-0 pl-1.5"
            >
              <span className="text-[10px] text-zinc-600">Was this right?</span>
              <button
                type="button"
                onClick={() => void submitVerdict({ verdict: "accepted" }).catch(() => {})}
                disabled={saving}
                title={`${risk ? "A real risk, and one you accept." : "This is right."} ${FEEDBACK_PURPOSE}`}
                className={BUTTON}
              >
                {risk ? "Accept risk" : "Agree"}
              </button>
              <button
                type="button"
                onClick={() => toggle("reject")}
                title={`This is wrong or not useful. ${FEEDBACK_PURPOSE}`}
                className={BUTTON}
              >
                Reject…
              </button>
              {ratings && (
                <button
                  type="button"
                  onClick={() => toggle("rerate")}
                  title={`Right, but rated too high or too low. ${FEEDBACK_PURPOSE}`}
                  className={BUTTON}
                >
                  Change rating…
                </button>
              )}
            </fieldset>
          ))}
      </div>

      {form === "reject" && (
        <RejectForm
          saving={saving}
          onSubmit={(reason) => submitVerdict({ verdict: "rejected", reason })}
          onCancel={() => setForm(null)}
        />
      )}
      {form === "rerate" && ratings && (
        <RerateForm
          ratings={ratings.filter((r) => r !== item.rating)}
          saving={saving}
          onSubmit={(rating, reason) => submitVerdict({ verdict: "rerated", rating, reason })}
          onCancel={() => setForm(null)}
        />
      )}
      {form === "ask" && <AskForm onSubmit={submitQuestion} />}

      {answer && (
        <div className="rounded border border-zinc-800 bg-zinc-900/60 p-2 text-xs text-zinc-300">
          <div className="mb-0.5 text-[10px] text-zinc-500">
            Answer · also saved as a note on these lines in the diff
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

function verdictText(shown: Pick<ReportFeedback, "verdict" | "rating">, risk: boolean): string {
  switch (shown.verdict) {
    case "accepted":
      return risk ? "You accepted this risk" : "You agreed";
    case "rejected":
      return "You rejected this";
    case "rerated":
      return shown.rating
        ? `You rated it ${RATING_LABEL[shown.rating].toLowerCase()}`
        : "You rerated this";
    default:
      return "";
  }
}

/** Why the item is wrong; a rejection with no reason teaches the checks nothing. */
function RejectForm({
  saving,
  onSubmit,
  onCancel,
}: {
  saving: boolean;
  onSubmit: (reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-start gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) void onSubmit(reason.trim()).catch(() => {});
      }}
    >
      <textarea
        aria-label="Why this is wrong"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this wrong or not useful?"
        rows={2}
        className={`min-w-[16rem] flex-1 ${INPUT}`}
      />
      <button type="submit" disabled={saving || !reason.trim()} className={BUTTON}>
        {saving ? "Saving…" : "Save rejection"}
      </button>
      <button type="button" onClick={onCancel} className={BUTTON}>
        Cancel
      </button>
    </form>
  );
}

function RerateForm({
  ratings,
  saving,
  onSubmit,
  onCancel,
}: {
  ratings: readonly FeedbackRating[];
  saving: boolean;
  onSubmit: (rating: FeedbackRating, reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [rating, setRating] = useState<FeedbackRating | "">("");
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-start gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (rating) void onSubmit(rating, reason.trim()).catch(() => {});
      }}
    >
      <select
        aria-label="New rating"
        value={rating}
        onChange={(e) => setRating(e.target.value as FeedbackRating | "")}
        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-1 text-xs text-zinc-300"
      >
        <option value="">Choose a rating</option>
        {ratings.map((r) => (
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
        className={`min-w-[12rem] flex-1 ${INPUT}`}
      />
      <button type="submit" disabled={saving || !rating} className={BUTTON}>
        {saving ? "Saving…" : "Save rating"}
      </button>
      <button type="button" onClick={onCancel} className={BUTTON}>
        Cancel
      </button>
    </form>
  );
}

function AskForm({ onSubmit }: { onSubmit: (question: string) => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  return (
    <form
      className="flex flex-wrap items-start gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!question.trim()) return;
        setAsking(true);
        onSubmit(question.trim())
          .catch(() => {})
          .finally(() => setAsking(false));
      }}
    >
      <input
        aria-label="Follow-up question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        placeholder="Ask about this, e.g. is it real, and how would you fix it?"
        className={`min-w-[16rem] flex-1 ${INPUT}`}
      />
      <button type="submit" disabled={asking || !question.trim()} className={BUTTON}>
        {asking ? "Asking…" : "Ask"}
      </button>
    </form>
  );
}
