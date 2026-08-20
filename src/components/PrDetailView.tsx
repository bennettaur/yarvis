import { type ReactNode, useEffect } from "react";
import { recordEvent } from "../lib/events";
import { usePrDetail } from "../lib/pr/cache";
import { refKey } from "../lib/pr/ref";
import type { CheckItem, PrSummary, Reviewer } from "../lib/pr/types";
import { usePrViewedFiles } from "../lib/pr/viewed";
import PrChecks from "./pr/PrChecks";
import PrDescription from "./pr/PrDescription";
import PrFileDiffs from "./pr/PrFileDiffs";
import PrFileList from "./pr/PrFileList";
import PrFloatingHeader from "./pr/PrFloatingHeader";
import PrGuidePanel, { PrGuideStart } from "./pr/PrGuidePanel";
import PrReviewers from "./pr/PrReviewers";
import { usePrGuide } from "./pr/usePrGuide";
import SplitPane, { usePersistedBoolean, usePersistedRatio } from "./SplitPane";

const FILE_LIST_COLLAPSED_KEY = "yarvis.pr.fileListCollapsed";
const FILE_LIST_RATIO_KEY = "yarvis.pr.fileListRatio";

function Section({
  title,
  action,
  children,
}: {
  title: string;
  /** Optional control shown beside the heading. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Short "2 passing · 1 failing" summary so the collapsed Checks header still reads. */
function checksSummary(checks: CheckItem[]): string {
  let passing = 0;
  let failing = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status !== "COMPLETED") pending++;
    else if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes((c.conclusion ?? "").toUpperCase()))
      passing++;
    else failing++;
  }
  const parts: string[] = [];
  if (passing) parts.push(`${passing} passing`);
  if (failing) parts.push(`${failing} failing`);
  if (pending) parts.push(`${pending} pending`);
  return parts.join(" · ");
}

/** Short "2 approved · 1 pending" summary so the collapsed Reviewers header still reads. */
function reviewersSummary(reviewers: Reviewer[]): string {
  let approved = 0;
  let changes = 0;
  let pending = 0;
  let commented = 0;
  for (const r of reviewers) {
    if (r.state === "pending") pending++;
    else if (r.state === "approved") approved++;
    else if (r.state === "changes_requested") changes++;
    else if (r.state === "commented") commented++;
  }
  const parts: string[] = [];
  if (approved) parts.push(`${approved} approved`);
  if (changes) parts.push(`${changes} requested changes`);
  if (pending) parts.push(`${pending} pending`);
  if (commented) parts.push(`${commented} commented`);
  return parts.join(" · ");
}

function CollapsibleSection({
  title,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details open={defaultOpen} className="group">
      <summary className="mb-2 flex cursor-pointer items-center gap-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-zinc-600 group-open:rotate-90 transition-transform">▶</span>
        {title}
        {summary && <span className="font-normal normal-case text-zinc-600">· {summary}</span>}
      </summary>
      {children}
    </details>
  );
}

/**
 * Full in-app PR review. Splits into a static header (title, derived lifecycle
 * status, and action buttons) at the top, and a scrolling body underneath with
 * the description, checks, and changed-file list. Owning the scroll here (the
 * tab's outer scroll is bypassed in App.tsx for the PRs tab) lets the header
 * stay anchored at the top without overlapping body content.
 *
 * The pieces share one fetch through the PR cache (keyed by the ref), so naming
 * the same PR here and in each child does not multiply requests.
 */
export default function PrDetailView({
  pr,
  onBack,
  recordView = true,
}: {
  pr: PrSummary;
  onBack: () => void;
  /**
   * Whether opening this view counts as the user viewing the PR. False when the
   * panel put us here on its own — restoring a remembered place isn't a fresh
   * view, and logging one on every app-tab round-trip would flood the activity
   * log with the same PR.
   */
  recordView?: boolean;
}) {
  const prRef = pr.ref;
  const { data: detail, error } = usePrDetail(prRef);
  // Shared so the file list and diffs stay in lockstep.
  const viewedFiles = usePrViewedFiles(prRef);
  // The last argument is what ticks off a step's files as the reader moves past
  // it; the hook decides which files that is.
  const guide = usePrGuide(prRef, pr.title, pr.url, viewedFiles.markAllViewed);

  // The file list panel is resizable (ratio) and fully collapsible, both
  // persisted so a chosen layout survives navigating between PRs.
  const [fileListRatio, setFileListRatio] = usePersistedRatio(FILE_LIST_RATIO_KEY, 0.25);
  const [fileListCollapsed, setFileListCollapsed] = usePersistedBoolean(
    FILE_LIST_COLLAPSED_KEY,
    false,
  );

  // Record opening a PR for review. Keyed strictly by PR identity (the ref key)
  // so re-renders (and metadata edits like a rename) don't re-fire; a different
  // PR records a new event. Fire-and-forget.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ref identity, not the unstable pr object
  useEffect(() => {
    if (!recordView) return;
    void recordEvent("pr.viewed", { ref: prRef, title: pr.title, url: pr.url }, prRef.provider);
  }, [refKey(prRef), recordView]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PrFloatingHeader pr={pr} detail={detail} onBack={onBack} />

      {/* The vertical padding lives on the inner wrapper, not this scroll
          container: a sticky file header uses `top-0` against this container, and
          a `padding-top` here would offset the sticky stop below the pane's top
          edge, letting diff content scroll up into the gap above the header.
          `data-pr-scroll` marks this element as the scroll pane so a collapsing
          file diff can re-anchor its header to the top (see PrFileDiffs'
          `toggleViewed`); keep the attribute if this markup moves. */}
      <div data-pr-scroll className="min-h-0 flex-1 overflow-y-auto px-6">
        <div className="space-y-5 py-5">
          {error && <p className="text-sm text-red-400">{error}</p>}

          <PrDescription prRef={prRef} />

          <CollapsibleSection
            title="Reviewers"
            summary={detail ? reviewersSummary(detail.reviewers) : undefined}
            defaultOpen={true}
          >
            <PrReviewers prRef={prRef} />
          </CollapsibleSection>

          <CollapsibleSection
            title="Checks"
            summary={detail ? checksSummary(detail.checks) : undefined}
            defaultOpen={false}
          >
            <PrChecks prRef={prRef} />
          </CollapsibleSection>

          <Section title="Files" action={<PrGuideStart guide={guide} />}>
            {fileListCollapsed ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFileListCollapsed(false)}
                  title="Show file list"
                  aria-label="Show file list"
                  className="sticky top-0 flex h-8 w-8 shrink-0 items-center justify-center self-start rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ›
                </button>
                <div className="min-w-0 flex-1">
                  <PrFileDiffs
                    prRef={prRef}
                    prUrl={pr.url}
                    viewed={viewedFiles.viewed}
                    onToggleViewed={viewedFiles.toggle}
                    focus={guide.focus}
                  />
                </div>
              </div>
            ) : (
              <SplitPane
                orientation="horizontal"
                ratio={fileListRatio}
                onRatioChange={setFileListRatio}
                minRatio={0.12}
                first={
                  <div className="sticky top-0 max-h-[80vh] overflow-auto pr-2">
                    <PrFileList
                      prRef={prRef}
                      prUrl={pr.url}
                      viewed={viewedFiles.viewed}
                      onToggleViewed={viewedFiles.toggle}
                      onCollapse={() => setFileListCollapsed(true)}
                    />
                  </div>
                }
                second={
                  <div className="min-w-0 pl-2">
                    <PrFileDiffs
                      prRef={prRef}
                      prUrl={pr.url}
                      viewed={viewedFiles.viewed}
                      onToggleViewed={viewedFiles.toggle}
                      focus={guide.focus}
                    />
                  </div>
                }
              />
            )}
          </Section>

          {/* Inside the scroll pane so the box can stick to its bottom edge —
              advancing a step scrolls the diff underneath it, and a box that
              scrolled away with the content would leave the reader without a
              Next button until they scrolled back to find it. */}
          <PrGuidePanel guide={guide} />
        </div>
      </div>
    </div>
  );
}
