import { useCallback, useEffect, useRef, useState } from "react";
import { usePrDetail } from "../../lib/pr/cache";
import { refKey } from "../../lib/pr/ref";
import type { PrSummary } from "../../lib/pr/types";
import {
  type ReviewWorkspacePr,
  refreshReviewPr,
  removeReviewPr,
} from "../../lib/reviewWorkspaces/api";
import { prWebUrl } from "../../lib/reviewWorkspaces/open";
import {
  invalidateLastReview,
  markReviewedHere,
  seenAt,
} from "../../lib/reviewWorkspaces/sinceReview";
import PrConflictBanner from "../pr/PrConflictBanner";
import {
  derivePrUiStatus,
  PrActionButtons,
  PrStatusBadge,
  usePrActions,
} from "../pr/PrFloatingHeader";
import ConfirmDialog from "./ConfirmDialog";
import NewCommitsBanner from "./NewCommitsBanner";
import { prLabel } from "./ReviewNav";
import type { PrColor, StaticTabKind } from "./tabs/types";
import { useDismiss } from "./useDismiss";

/** What the classic review's actions need of a PR, built from the workspace row and its detail. */
export function summaryFor(pr: ReviewWorkspacePr, detail: ReturnType<typeof usePrDetail>["data"]) {
  return {
    ref: pr.ref,
    title: detail?.title || pr.title,
    url: prWebUrl(pr.ref),
    author: detail?.author || pr.author || "",
    draft: detail?.draft ?? false,
    state: detail?.state ?? "open",
    createdAt: "",
    updatedAt: "",
  } satisfies PrSummary;
}

/** Mutation testing and the checkout's controls, kept off the bar so it fits on one row. */
function MoreMenu({
  busy,
  cloning,
  canMark,
  onUpdate,
  onMark,
  onRemove,
  onMutation,
}: {
  busy: boolean;
  cloning: boolean;
  /** The checkout has a head to mark. */
  canMark: boolean;
  onUpdate: () => void;
  onMark: () => void;
  onRemove: () => void;
  onMutation: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(menu, open, close);
  const item =
    "whitespace-nowrap rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
  return (
    <div ref={menu} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="More for this PR"
        aria-expanded={open}
        title="More for this PR"
        className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
          <button
            type="button"
            disabled={busy || cloning}
            onClick={() => {
              setOpen(false);
              onUpdate();
            }}
            title="Fetch the PR's latest commits into the checkout"
            className={item}
          >
            Update checkout
          </button>
          <button
            type="button"
            disabled={busy || !canMark}
            onClick={() => {
              setOpen(false);
              onMark();
            }}
            title="Record the checkout's commit as where you last reviewed, for “Since last review”"
            className={item}
          >
            Mark reviewed here
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            title="Remove this PR and its checkout from the workspace"
            className={item}
          >
            Remove from workspace
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onMutation();
            }}
            title="See whether the PR's tests notice small bugs in the code it changes"
            className={item}
          >
            Mutation testing
          </button>
        </div>
      )}
    </div>
  );
}

/** How often the bar re-reads the PR from the provider to notice a push. */
const NEW_COMMITS_POLL_MS = 2 * 60 * 1000;

const AGENT_TABS: { kind: StaticTabKind; label: string; title: string }[] = [
  { kind: "guide", label: "Guided review", title: "Walk through the PR step by step" },
  {
    kind: "verification",
    label: "Verification",
    title: "Have an agent check the PR does what it says",
  },
];

/**
 * The bar for the PR in front: whichever one the focused tab belongs to. It
 * carries that PR's colour, the review actions the classic page has, the
 * agent-powered tabs, and the checkout's own controls.
 */
export default function ReviewPrBar({
  workspaceId,
  pr,
  color,
  readOnly,
  openTab,
  onChanged,
}: {
  workspaceId: string;
  pr: ReviewWorkspacePr;
  color: PrColor;
  readOnly: boolean;
  openTab: (kind: StaticTabKind) => void;
  /** Something about the PR's row changed: re-read the workspace. */
  onChanged: () => void;
}) {
  const { data: detail, loading, refreshing, refresh: refreshDetail } = usePrDetail(pr.ref);
  const actions = usePrActions(pr.ref, seenAt(pr));
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [marked, setMarked] = useState<string | null>(null);
  const summary = summaryFor(pr, detail);
  const status = derivePrUiStatus(detail, summary);

  // The detail is what says a push happened. Nothing else re-reads it while the
  // PR sits open, so ask again now and then — only while the window is in view,
  // since each ask is a provider call.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refreshDetail();
    }, NEW_COMMITS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshDetail]);

  const runCheckout = async (op: () => Promise<unknown>) => {
    setCheckoutBusy(true);
    actions.setError(null);
    try {
      await op();
      onChanged();
    } catch (e) {
      actions.setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCheckoutBusy(false);
    }
  };

  const markHere = () =>
    runCheckout(async () => {
      const mark = await markReviewedHere(workspaceId, pr.id);
      invalidateLastReview(pr.ref);
      setMarked(mark.headSha);
    });

  const remove = async () => {
    await removeReviewPr(workspaceId, pr.id);
    onChanged();
  };

  return (
    <div
      className={`shrink-0 border-b border-l-4 border-b-zinc-800 ${color.border} bg-zinc-950 px-3 py-2`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${color.bg}`} aria-hidden />
        <span className={`shrink-0 text-xs font-medium ${color.text}`}>{prLabel(pr)}</span>
        <h2
          className="min-w-32 flex-1 truncate text-sm font-semibold text-zinc-100"
          title={summary.title}
        >
          {summary.title || <span className="font-normal italic text-zinc-500">Loading…</span>}
        </h2>
        <PrStatusBadge status={status} />
        {AGENT_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => openTab(t.kind)}
            title={t.title}
            className="shrink-0 whitespace-nowrap rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
          >
            {t.label}
          </button>
        ))}
        <PrActionButtons
          pr={summary}
          detail={detail}
          actions={actions}
          reloading={loading || refreshing}
        />
        {!readOnly && (
          <MoreMenu
            busy={checkoutBusy}
            cloning={pr.status === "cloning"}
            canMark={pr.status === "ready" && !!pr.headSha}
            onUpdate={() => void runCheckout(() => refreshReviewPr(workspaceId, pr.id))}
            onMark={() => void markHere()}
            onRemove={() => setConfirmingRemove(true)}
            onMutation={() => openTab("mutation")}
          />
        )}
      </div>
      <NewCommitsBanner
        key={pr.id}
        workspaceId={workspaceId}
        pr={pr}
        providerHead={detail?.headSha}
        readOnly={readOnly}
        onRefreshed={onChanged}
        onSeeChanges={() => openTab("since-review")}
      />
      {marked && marked === pr.headSha && (
        <p className="mt-1 text-xs text-emerald-300">
          Marked reviewed at <span className="font-mono">{marked.slice(0, 7)}</span>. “Since last
          review” starts from here now.
        </p>
      )}
      <PrConflictBanner key={refKey(pr.ref)} prRef={pr.ref} detail={detail} />
      {actions.error && <p className="mt-1 text-xs text-red-400">{actions.error}</p>}
      {confirmingRemove && (
        <ConfirmDialog
          title={`Remove ${prLabel(pr)} from the workspace?`}
          confirmLabel="Remove"
          busyLabel="Removing…"
          onConfirm={remove}
          onClose={() => setConfirmingRemove(false)}
        >
          Closes its tabs and deletes its checkout. Comments and reviews on the provider are
          untouched, and you can add the PR again later.
        </ConfirmDialog>
      )}
    </div>
  );
}
