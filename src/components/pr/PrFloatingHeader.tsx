import { useEffect, useRef, useState } from "react";
import {
  applyReviewAction,
  disableAutoMerge,
  enableAutoMerge,
  mergePr,
  type ReviewAction,
} from "../../lib/pr/api";
import { invalidate, prDetailKey, prStackKey } from "../../lib/pr/cache";
import { refDisplayRepo, refNumber, refProviderName } from "../../lib/pr/ref";
import type { CheckItem, MergeMethod, PrDetail, PrRef, PrSummary } from "../../lib/pr/types";
import { openExternal } from "../../lib/url";
import CopyLinkButton from "../CopyLinkButton";
import PrWorkspaceAction from "./PrWorkspaceAction";

/**
 * The high-level lifecycle states the UI shows in the floating header.
 * `awaiting_review` is the catch-all for an open PR with no clearer signal.
 * Terminal states (`merged`, `closed`) suppress all review actions — there's
 * nothing left to approve or request changes on.
 */
export type PrUiStatus =
  | "draft"
  | "ci_failing"
  | "awaiting_review"
  | "ready_to_merge"
  | "merged"
  | "closed";

/**
 * Derives the single-line status shown in the floating header. Provider state
 * vocabularies vary (GitHub GraphQL: OPEN/CLOSED/MERGED; the workspace poller
 * cache: open/closed/merged; Azure: active/completed/abandoned), so the
 * comparison is case-folded and covers all three. Terminal states win over
 * everything else — a merged PR's CI history doesn't change the verdict.
 * CI-failing then wins over draft so a draft with a broken pipeline still
 * surfaces the failure rather than nagging the author to mark it ready.
 */
export function derivePrUiStatus(detail: PrDetail | null, summary: PrSummary): PrUiStatus {
  const state = (detail?.state ?? summary.state ?? "").toLowerCase();
  if (state === "merged" || state === "completed") return "merged";
  if (state === "closed" || state === "abandoned") return "closed";
  const checks: CheckItem[] = detail?.checks ?? [];
  const ciFailing = checks.some(
    (c) =>
      c.status === "COMPLETED" &&
      !["SUCCESS", "NEUTRAL", "SKIPPED", null].includes((c.conclusion ?? "").toUpperCase()),
  );
  if (ciFailing) return "ci_failing";
  const isDraft = detail?.draft ?? summary.draft;
  if (isDraft) return "draft";
  const ciPending = checks.some((c) => c.status !== "COMPLETED");
  if (!ciPending && detail?.mergeable === "MERGEABLE") return "ready_to_merge";
  return "awaiting_review";
}

const STATUS_LABEL: Record<PrUiStatus, string> = {
  draft: "Draft",
  ci_failing: "CI failing",
  awaiting_review: "Awaiting review",
  ready_to_merge: "Ready to merge",
  merged: "Merged",
  closed: "Closed",
};

const STATUS_COLOR: Record<PrUiStatus, string> = {
  draft: "bg-zinc-700 text-zinc-200",
  ci_failing: "bg-red-900/60 text-red-200",
  awaiting_review: "bg-amber-900/40 text-amber-200",
  ready_to_merge: "bg-emerald-900/60 text-emerald-200",
  merged: "bg-violet-900/60 text-violet-200",
  closed: "bg-zinc-800 text-zinc-400",
};

/**
 * A small composer that captures an optional review comment before the action
 * fires. `required` flips the button to disabled until the user types
 * something; we use it for request-changes (both providers reject an empty
 * body) so the failure happens client-side rather than as a 400 round-trip.
 */
function CommentPrompt({
  label,
  placeholder,
  required,
  pending,
  onConfirm,
  onCancel,
}: {
  label: string;
  placeholder: string;
  required: boolean;
  pending: boolean;
  onConfirm: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Focus the composer when it pops open without using autoFocus (which biome
  // flags for a11y). A11y-wise, focus following the user's deliberate click
  // onto "Approve"/"Request changes" is the expected behavior.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  const disabled = pending || (required && !text.trim());
  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
      <textarea
        ref={textareaRef}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="w-72 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(text)}
          disabled={disabled}
          className="rounded-md bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {pending ? "…" : label}
        </button>
      </div>
    </div>
  );
}

interface ActionConfig {
  key: ReviewAction;
  label: string;
  className: string;
  /** Open the comment composer instead of firing immediately. */
  confirmInline: boolean;
  /** When `confirmInline`, whether an empty body is rejected client-side. */
  requireBody: boolean;
  placeholder: string;
  confirmLabel: string;
}

const APPROVE: ActionConfig = {
  key: "approve",
  label: "Approve",
  className: "bg-emerald-600 hover:bg-emerald-500",
  confirmInline: true,
  requireBody: false,
  placeholder: "Optional comment for the approval…",
  confirmLabel: "Approve",
};

const REQUEST_CHANGES: ActionConfig = {
  key: "request_changes",
  label: "Request changes",
  className: "bg-red-600 hover:bg-red-500",
  confirmInline: true,
  requireBody: true,
  placeholder: "What needs to change?",
  confirmLabel: "Submit",
};

const PUBLISH: ActionConfig = {
  key: "publish",
  label: "Ready for review",
  className: "bg-indigo-600 hover:bg-indigo-500",
  confirmInline: false,
  requireBody: false,
  placeholder: "",
  confirmLabel: "Publish",
};

/**
 * Returns the action buttons relevant for the current status. Approval &
 * request-changes are hidden on drafts (you can't review a draft), and the
 * publish button is only relevant for drafts. Ready-to-merge keeps the
 * approve/request-changes buttons available — sometimes a second review is
 * still needed, or you might want to push back even on a green PR.
 */
function actionsForStatus(status: PrUiStatus): ActionConfig[] {
  if (status === "draft") return [PUBLISH];
  // Terminal states leave nothing to act on — no approve / request-changes.
  if (status === "merged" || status === "closed") return [];
  return [APPROVE, REQUEST_CHANGES];
}

/** Human labels for the merge strategies, mirroring GitHub's own wording. */
const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  MERGE: "Create a merge commit",
  SQUASH: "Squash and merge",
  REBASE: "Rebase and merge",
};

/** Which merge controls the header should offer for the current PR. */
export interface MergeControls {
  /** Merge now (PR is mergeable and checks are green). */
  merge: boolean;
  /** Arm auto-merge (repo allows it and the viewer has permission). */
  enableAuto: boolean;
  /** Cancel an already-armed auto-merge. */
  disableAuto: boolean;
}

const NO_MERGE_CONTROLS: MergeControls = { merge: false, enableAuto: false, disableAuto: false };

/**
 * Decides which merge buttons are available for a PR. Terminal PRs and any PR
 * whose repo exposes no merge methods (e.g. Azure) get none. When auto-merge is
 * already armed the only control is cancelling it. Otherwise "Merge" shows once
 * the PR is ready to merge, and "Enable auto-merge" shows when it isn't yet but
 * the viewer may arm it — the two are complementary, never both at once.
 */
export function mergeControlsFor(detail: PrDetail | null, status: PrUiStatus): MergeControls {
  if (!detail) return NO_MERGE_CONTROLS;
  if (status === "merged" || status === "closed") return NO_MERGE_CONTROLS;
  if (detail.autoMergeEnabled) {
    return { merge: false, enableAuto: false, disableAuto: detail.canDisableAutoMerge };
  }
  if (detail.mergeMethods.length === 0) return NO_MERGE_CONTROLS;
  const merge = status === "ready_to_merge";
  return { merge, enableAuto: !merge && detail.canEnableAutoMerge, disableAuto: false };
}

/**
 * A button that opens a small popover of the repo's allowed merge strategies;
 * picking one fires the action. Used for both "Merge" and "Enable auto-merge",
 * which share the strategy choice but differ in what they do with it.
 */
function MergeMenu({
  label,
  className,
  methods,
  pending,
  isOpen,
  disabled,
  onToggle,
  onPick,
}: {
  label: string;
  className: string;
  methods: MergeMethod[];
  pending: boolean;
  isOpen: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPick: (method: MergeMethod) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors disabled:opacity-50 ${className}`}
      >
        {pending ? "…" : label}
      </button>
      {isOpen && (
        <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-1 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onPick(m)}
              className="whitespace-nowrap rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800"
            >
              {MERGE_METHOD_LABEL[m]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The static title/status bar at the top of the in-app PR review. Sits above
 * the scrolling body (the parent `PrDetailView` is a flex column whose body
 * owns the scroll), so it never overlaps body content as the user scrolls.
 * Renders the title, lifecycle status badge, and the publish / approve /
 * request-changes action buttons.
 *
 * The action handlers invalidate the PR cache so the cached detail (which
 * fed the draft / mergeable state) is refetched after a publish or vote.
 */
export default function PrFloatingHeader({
  pr,
  detail,
  loading = false,
  onBack,
}: {
  pr: PrSummary;
  detail: PrDetail | null;
  /**
   * Whether the detail behind this header is still on its way. Clicking a layer
   * of a stack swaps the pull request instantly and then waits on a provider
   * round trip, so without saying so the header reads as a click that did
   * nothing (#268).
   */
  loading?: boolean;
  onBack: () => void;
}) {
  const prRef: PrRef = pr.ref;
  // Publishing, approving or merging changes both how this pull request reads
  // and how its layer reads in the stack section below, so the two caches are
  // dropped together.
  const invalidatePr = (ref: PrRef) => {
    invalidate(prDetailKey(ref));
    invalidate(prStackKey(ref));
  };
  const [open, setOpen] = useState<ReviewAction | null>(null);
  const [pending, setPending] = useState<ReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Merge controls run on their own pending flag so a merge in flight and a
  // review in flight don't clobber each other's spinner.
  const [mergeMenu, setMergeMenu] = useState<null | "merge" | "auto_merge">(null);
  const [mergePending, setMergePending] = useState(false);

  const status = derivePrUiStatus(detail, pr);
  const actions = actionsForStatus(status);
  const mergeControls = mergeControlsFor(detail, status);
  const busy = pending !== null || mergePending;

  const run = async (action: ReviewAction, body?: string) => {
    setPending(action);
    setError(null);
    try {
      await applyReviewAction(prRef, action, body);
      invalidatePr(prRef);
      setOpen(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  const runMerge = async (op: "merge" | "auto_merge", method: MergeMethod) => {
    setMergePending(true);
    setError(null);
    try {
      if (op === "merge") await mergePr(prRef, method);
      else await enableAutoMerge(prRef, method);
      invalidatePr(prRef);
      setMergeMenu(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergePending(false);
    }
  };

  const runDisableAutoMerge = async () => {
    setMergePending(true);
    setError(null);
    try {
      await disableAutoMerge(prRef);
      invalidatePr(prRef);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMergePending(false);
    }
  };

  return (
    <div aria-busy={loading} className="shrink-0 border-b border-zinc-800 bg-[#0a0a0a] px-6 py-3">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
        >
          ← Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {/* Prefer the detail's title — the summary's title can be empty
                when the entry came from the workspace poller cache (which
                doesn't store PR titles). Show a placeholder while detail
                loads so the bar isn't blank. */}
            <h2
              className="min-w-0 truncate text-base font-semibold text-zinc-100"
              title={detail?.title || pr.title}
            >
              {detail?.title || pr.title || (
                <span className="font-normal italic text-zinc-500">Loading…</span>
              )}
            </h2>
            <span className="font-normal text-zinc-500">#{refNumber(prRef)}</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
            <span className="truncate">
              {refDisplayRepo(prRef)} · {detail?.author || pr.author || "—"}
            </span>
            {loading && <span className="shrink-0 animate-pulse text-indigo-300">Loading…</span>}
          </div>
        </div>
        <span
          className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status]}`}
        >
          {STATUS_LABEL[status]}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <PrWorkspaceAction prRef={prRef} fromFork={detail?.fromFork ?? false} />
          {actions.map((cfg) => {
            const isPending = pending === cfg.key;
            const isOpen = open === cfg.key;
            const onClick = cfg.confirmInline
              ? () => setOpen(isOpen ? null : cfg.key)
              : () => void run(cfg.key);
            return (
              <div key={cfg.key} className="relative">
                <button
                  onClick={onClick}
                  disabled={busy}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors disabled:opacity-50 ${cfg.className}`}
                >
                  {isPending ? "…" : cfg.label}
                </button>
                {isOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1">
                    <CommentPrompt
                      label={cfg.confirmLabel}
                      placeholder={cfg.placeholder}
                      required={cfg.requireBody}
                      pending={isPending}
                      onConfirm={(body) => void run(cfg.key, body)}
                      onCancel={() => setOpen(null)}
                    />
                  </div>
                )}
              </div>
            );
          })}
          {detail?.autoMergeEnabled && (
            <span className="rounded bg-sky-900/60 px-2 py-0.5 text-xs font-medium text-sky-200">
              Auto-merge on
            </span>
          )}
          {mergeControls.merge && detail && (
            <MergeMenu
              label="Merge"
              className="bg-emerald-600 hover:bg-emerald-500"
              methods={detail.mergeMethods}
              pending={mergePending}
              isOpen={mergeMenu === "merge"}
              disabled={busy}
              onToggle={() => setMergeMenu(mergeMenu === "merge" ? null : "merge")}
              onPick={(method) => void runMerge("merge", method)}
            />
          )}
          {mergeControls.enableAuto && detail && (
            <MergeMenu
              label="Enable auto-merge"
              className="bg-sky-600 hover:bg-sky-500"
              methods={detail.mergeMethods}
              pending={mergePending}
              isOpen={mergeMenu === "auto_merge"}
              disabled={busy}
              onToggle={() => setMergeMenu(mergeMenu === "auto_merge" ? null : "auto_merge")}
              onPick={(method) => void runMerge("auto_merge", method)}
            />
          )}
          {mergeControls.disableAuto && (
            <button
              type="button"
              onClick={() => void runDisableAutoMerge()}
              disabled={busy}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-800 disabled:opacity-50"
            >
              {mergePending ? "…" : "Cancel auto-merge"}
            </button>
          )}
          <button
            onClick={() => openExternal(pr.url)}
            className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            title={`Open on ${refProviderName(prRef)}`}
          >
            ↗
          </button>
          <CopyLinkButton
            url={pr.url}
            subject="PR link"
            title={`Copy the ${refProviderName(prRef)} link to this PR`}
          />
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
