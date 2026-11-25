import { useMemo, useState } from "react";
import { applyReviewAction, postPrComment } from "../../../lib/pr/api";
import { prDetailKey, prStackKey } from "../../../lib/pr/cache";
import type { PrRef, SeenCommits } from "../../../lib/pr/types";
import { invalidate } from "../../../lib/resourceCache";
import {
  type Assessment,
  assessReview,
  type DraftComment,
  draftComments,
  reviewSummary,
  SUGGESTION_LABEL,
  type Suggestion,
  whereToLook,
} from "../../../lib/reviewWorkspaces/decision";
import type { MutationRun } from "../../../lib/reviewWorkspaces/mutation";
import { invalidateLastReview } from "../../../lib/reviewWorkspaces/sinceReview";
import type {
  ChecklistItem,
  EvidenceItem,
  VerificationReport,
  VerificationUpstack,
} from "../../../lib/reviewWorkspaces/verification";
import { Location, type OpenLocation } from "./VerificationReportView";

const SUGGESTION_CLASS: Record<Suggestion, string> = {
  approve: "border-emerald-800 text-emerald-300",
  request_changes: "border-red-800 text-red-300",
  review_deeper: "border-amber-800 text-amber-300",
  run_checks: "border-zinc-700 text-zinc-400",
};

type Mode = Exclude<Suggestion, "run_checks">;

const MODE_LABEL: Record<Mode, string> = {
  approve: "Approve",
  request_changes: "Request changes",
  review_deeper: "Review deeper",
};

const BUTTON =
  "rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";

function Reasons({ assessment }: { assessment: Assessment }) {
  const { blockers, concerns, notRun } = assessment;
  if (blockers.length + concerns.length + notRun.length === 0) {
    return (
      <p className="text-xs text-zinc-400">
        CI passed, and the claims and checks found nothing that blocks this PR.
      </p>
    );
  }
  return (
    <ul className="space-y-0.5 text-xs">
      {blockers.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two blockers can read the same, and the list is rebuilt whole
        <li key={`b:${i}`} className="text-red-300">
          {b}
        </li>
      ))}
      {concerns.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: as above
        <li key={`c:${i}`} className="text-amber-300">
          {c}
        </li>
      ))}
      {notRun.length > 0 && (
        <li className="text-zinc-400">Not run on this commit: {notRun.join(", ")}</li>
      )}
    </ul>
  );
}

/** What the reviewer sends with an approval; nothing more than a note. */
function ApproveForm({
  assessment,
  onSubmit,
  busy,
}: {
  assessment: Assessment;
  onSubmit: (body: string) => void;
  busy: boolean;
}) {
  const [body, setBody] = useState("");
  const raisedCount = assessment.blockers.length + assessment.concerns.length;
  const notRun = assessment.notRun.length;
  return (
    <div className="space-y-2">
      {raisedCount + notRun > 0 && (
        <p className="text-xs text-amber-300">
          {raisedCount > 0 &&
            `The report raised ${raisedCount === 1 ? "one thing" : `${raisedCount} things`} above. `}
          {notRun > 0 &&
            `${notRun === 1 ? "One check hasn't" : `${notRun} checks haven't`} run on this commit. `}
          Approve only if you've looked for yourself.
        </p>
      )}
      <textarea
        aria-label="Approval comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Optional comment for the author"
        rows={2}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
      />
      <button type="button" disabled={busy} onClick={() => onSubmit(body)} className={BUTTON}>
        {busy ? "Approving…" : "Submit approval"}
      </button>
    </div>
  );
}

/**
 * The comments a "request changes" review would carry, each to tick and edit,
 * and the summary that goes with the verdict. Those with a line go on it; the
 * rest are written into the summary.
 *
 * Ticks and edits are kept by each comment's id, which names what it is about,
 * so they stay with their comment when the report refreshes underneath; a
 * comment that arrives later starts ticked or not by its own default.
 */
function RequestChangesForm({
  drafts,
  posted,
  onSubmit,
  busy,
}: {
  drafts: DraftComment[];
  /** Comments already posted by an earlier try, so a retry doesn't repeat them. */
  posted: ReadonlySet<string>;
  onSubmit: (chosen: DraftComment[], summary: string) => void;
  busy: boolean;
}) {
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [typedSummary, setTypedSummary] = useState<string | null>(null);
  const isPicked = (d: DraftComment) => ticks[d.id] ?? d.pickedByDefault;
  const chosen = drafts.filter(isPicked).map((d) => ({ ...d, body: edits[d.id] ?? d.body }));
  // Drafted from what is ticked until the reviewer edits it.
  const summary = typedSummary ?? reviewSummary(chosen);

  return (
    <div className="space-y-2">
      {drafts.length === 0 && (
        <p className="text-xs text-zinc-400">
          The report has nothing to raise. Say what needs changing in the summary below.
        </p>
      )}
      <ul className="space-y-2">
        {drafts.map((d) => (
          <li key={d.id} className="space-y-1 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`Include ${d.title}`}
                checked={isPicked(d)}
                onChange={() => setTicks((prev) => ({ ...prev, [d.id]: !isPicked(d) }))}
                disabled={posted.has(d.id)}
              />
              <span className="text-[10px] uppercase text-zinc-500">{d.severity}</span>
              <span className="text-zinc-200">{d.title}</span>
              <span className="text-zinc-500">{d.source}</span>
              {d.path && d.line ? (
                <span className="font-mono text-[11px] text-zinc-400">
                  {d.path}:{d.line}
                </span>
              ) : (
                <span className="text-[11px] text-zinc-500">in the summary</span>
              )}
              {posted.has(d.id) && <span className="text-emerald-400">posted</span>}
            </label>
            {isPicked(d) && !posted.has(d.id) && (
              <textarea
                aria-label={`Comment on ${d.title}`}
                value={edits[d.id] ?? d.body}
                onChange={(e) => setEdits((prev) => ({ ...prev, [d.id]: e.target.value }))}
                rows={3}
                className="ml-5 w-[calc(100%-1.25rem)] rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-200"
              />
            )}
          </li>
        ))}
      </ul>
      <textarea
        aria-label="Review summary"
        value={summary}
        onChange={(e) => setTypedSummary(e.target.value)}
        rows={4}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200"
      />
      {typedSummary !== null && (
        <button
          type="button"
          onClick={() => setTypedSummary(null)}
          className="text-[11px] text-sky-400 hover:text-sky-300"
        >
          Draft the summary again from what's ticked
        </button>
      )}
      <button
        type="button"
        disabled={busy || !summary.trim()}
        onClick={() => onSubmit(chosen, summary)}
        className={BUTTON}
      >
        {busy
          ? "Requesting changes…"
          : `Request changes${chosen.length ? ` (${chosen.length})` : ""}`}
      </button>
    </div>
  );
}

/**
 * The checklist's verdict and what to do with it: the suggested decision and
 * every reason for it, then approve, request changes with comments drafted
 * from the report, or a list of where to review deeper. Nothing goes to the
 * PR until the reviewer submits.
 */
export default function DecisionPanel({
  prRef,
  seen,
  report,
  evidence,
  items,
  mutation = null,
  upstack = null,
  currentSections,
  changedPaths,
  onOpen,
}: {
  prRef: PrRef;
  /** The head the review is of, recorded with each comment and the verdict. */
  seen: SeenCommits;
  report: VerificationReport | null;
  /** CI and scanner results for the PR's head; null when there are none for it. */
  evidence: readonly EvidenceItem[] | null;
  items: readonly ChecklistItem[];
  /** The PR's latest mutation-testing pass, if it has had one. */
  mutation?: MutationRun | null;
  /** What the PRs stacked on this one change in it, read at its head. */
  upstack?: VerificationUpstack | null;
  /** Sections whose result is for the PR's head; only these comment on lines. */
  currentSections: ReadonlySet<string>;
  /** The files the PR changes, the only ones a comment can go on; absent until loaded. */
  changedPaths?: ReadonlySet<string>;
  onOpen: OpenLocation;
}) {
  const assessment = useMemo(
    () => assessReview(report, evidence, items, mutation, upstack),
    [report, evidence, items, mutation, upstack],
  );
  const drafts = useMemo(
    () => draftComments(report, evidence, currentSections, changedPaths),
    [report, evidence, currentSections, changedPaths],
  );
  const places = useMemo(() => whereToLook(report), [report]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  // Kept per head: after a push, nothing posted at the old one counts.
  const [postedAt, setPostedAt] = useState<{ head: string; ids: ReadonlySet<string> }>({
    head: "",
    ids: new Set(),
  });
  const posted = postedAt.head === seen.headSha ? postedAt.ids : new Set<string>();
  const intent = report?.changeMap?.intent ?? report?.summary;

  // Refetch so the PR's threads, its vote in a stack, and the "last reviewed"
  // mark show what was just sent.
  const refreshPr = () => {
    invalidate(prDetailKey(prRef));
    invalidate(prStackKey(prRef));
    invalidateLastReview(prRef);
  };

  const approve = async (body: string) => {
    setBusy(true);
    setError(null);
    try {
      await applyReviewAction(prRef, "approve", body.trim() || undefined, seen);
      refreshPr();
      setDoneMessage("Approved.");
      setMode(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Line comments go first, one at a time; the verdict is sent only once all
  // of them are up, so a failure never leaves a verdict pointing at comments
  // that aren't there. A retry skips the ones already posted.
  const requestChanges = async (chosen: DraftComment[], summary: string) => {
    setBusy(true);
    setError(null);
    const nowPosted = new Set(posted);
    try {
      for (const d of chosen) {
        if (!d.path || !d.line || nowPosted.has(d.id)) continue;
        await postPrComment(prRef, { path: d.path, line: d.line, body: d.body }, seen);
        nowPosted.add(d.id);
      }
      await applyReviewAction(prRef, "request_changes", summary, seen);
      setDoneMessage("Changes requested.");
      setMode(null);
      nowPosted.clear();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Whatever went up shows on the PR, even when the rest didn't.
      refreshPr();
      setPostedAt({ head: seen.headSha ?? "", ids: nowPosted });
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Decision</h3>
        <span
          className={`rounded border px-1.5 py-0.5 text-[11px] ${SUGGESTION_CLASS[assessment.suggestion]}`}
        >
          {SUGGESTION_LABEL[assessment.suggestion]}
        </span>
        <span className="ml-auto flex gap-1.5">
          {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setDoneMessage(null);
                setMode(mode === m ? null : m);
              }}
              className={`${BUTTON} ${mode === m ? "bg-zinc-800" : ""}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </span>
      </div>
      {intent && <p className="text-sm text-zinc-200">{intent}</p>}
      <Reasons assessment={assessment} />

      {mode === "approve" && (
        <ApproveForm assessment={assessment} onSubmit={(b) => void approve(b)} busy={busy} />
      )}
      {mode === "request_changes" && (
        <RequestChangesForm
          drafts={drafts}
          posted={posted}
          onSubmit={(c, s) => void requestChanges(c, s)}
          busy={busy}
        />
      )}
      {mode === "review_deeper" &&
        (places.length === 0 ? (
          <p className="text-xs text-zinc-400">
            Run the change map, summary or checks to see where to look first.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {places.map((p) => (
              <li key={p.path} className="flex flex-wrap items-baseline gap-2">
                <Location path={p.path} line={p.line} onOpen={onOpen} />
                <span className="text-zinc-400">{p.reason}</span>
              </li>
            ))}
          </ul>
        ))}

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {doneMessage && (
        <p role="status" className="text-xs text-emerald-400">
          {doneMessage}
        </p>
      )}
    </section>
  );
}
