import { type ReactNode, useEffect, useState } from "react";
import { recordEvent } from "../lib/events";
import { usePrDetail } from "../lib/pr/cache";
import { refKey } from "../lib/pr/ref";
import type { CheckItem, PrSummary } from "../lib/pr/types";
import { usePrViewedFiles } from "../lib/pr/viewed";
import PrChecks from "./pr/PrChecks";
import PrDescription from "./pr/PrDescription";
import PrFileDiffs from "./pr/PrFileDiffs";
import PrFileList from "./pr/PrFileList";
import PrFloatingHeader from "./pr/PrFloatingHeader";
import SplitPane, { usePersistedRatio } from "./SplitPane";

const FILE_LIST_COLLAPSED_KEY = "yarvis.pr.fileListCollapsed";
const FILE_LIST_RATIO_KEY = "yarvis.pr.fileListRatio";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
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
export default function PrDetailView({ pr, onBack }: { pr: PrSummary; onBack: () => void }) {
  const prRef = pr.ref;
  const { data: detail, error } = usePrDetail(prRef);
  // Shared so the file list and diffs stay in lockstep.
  const viewedFiles = usePrViewedFiles(prRef);

  // The file list panel is resizable (ratio) and fully collapsible, both
  // persisted so a chosen layout survives navigating between PRs.
  const [fileListRatio, setFileListRatio] = usePersistedRatio(FILE_LIST_RATIO_KEY, 0.25);
  const [fileListCollapsed, setFileListCollapsed] = useState<boolean>(
    () => localStorage.getItem(FILE_LIST_COLLAPSED_KEY) === "1",
  );
  useEffect(() => {
    localStorage.setItem(FILE_LIST_COLLAPSED_KEY, fileListCollapsed ? "1" : "0");
  }, [fileListCollapsed]);

  // Record opening a PR for review. Keyed strictly by PR identity (the ref key)
  // so re-renders (and metadata edits like a rename) don't re-fire; a different
  // PR records a new event. Fire-and-forget.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the ref identity, not the unstable pr object
  useEffect(() => {
    void recordEvent("pr.viewed", { ref: prRef, title: pr.title, url: pr.url }, prRef.provider);
  }, [refKey(prRef)]);

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
            title="Checks"
            summary={detail ? checksSummary(detail.checks) : undefined}
            defaultOpen={false}
          >
            <PrChecks prRef={prRef} />
          </CollapsibleSection>

          <Section title="Files">
            {fileListCollapsed ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFileListCollapsed(false)}
                  title="Show file list"
                  className="sticky top-0 flex h-8 w-8 shrink-0 items-center justify-center self-start rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  ›
                </button>
                <div className="min-w-0 flex-1">
                  <PrFileDiffs
                    prRef={prRef}
                    viewed={viewedFiles.viewed}
                    onToggleViewed={viewedFiles.toggle}
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
                  <div className="sticky top-0 max-h-[80vh] self-start overflow-auto pr-2">
                    <PrFileList
                      prRef={prRef}
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
                      viewed={viewedFiles.viewed}
                      onToggleViewed={viewedFiles.toggle}
                    />
                  </div>
                }
              />
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
