import { useEffect, useRef } from "react";
import { stepPaths } from "../../../lib/pr/guide";
import LoadingIndicator from "../../LoadingIndicator";
import PrGuidePanel, { PrGuideStart, stepLocation } from "../../pr/PrGuidePanel";
import type { DiffFocus } from "../../pr/shared";
import { usePrGuide } from "../../pr/usePrGuide";
import { useReviewViewed } from "./reviewData";
import type { TabContext, TabSpec } from "./types";

/**
 * Where a guide focus takes the reader: the file's diff, at the step's first
 * line. Null for a focus the tab has already acted on, so re-rendering never
 * re-opens a tab the reader has since closed.
 */
export function guideFocusTab(
  prId: string,
  focus: DiffFocus | null,
  handledNonce: number | null,
): TabSpec | null {
  if (!focus || focus.nonce === handledNonce) return null;
  return {
    kind: "diff",
    prId,
    path: focus.path,
    ...(focus.startLine != null ? { revealLine: focus.startLine } : {}),
  };
}

/**
 * The guided review as a tab: the whole tour down the side, and the step the
 * reader is on beside it. Every move — Next, Back, a step, a flagged finding,
 * a covered file — opens that place in a diff tab, and moving past a step
 * marks its files viewed, as the classic review does.
 */
export default function GuideTab({ ctx }: { ctx: TabContext }) {
  const viewed = useReviewViewed(ctx.prRef);
  const guide = usePrGuide(ctx.prRef, ctx.pr.title, undefined, viewed.markAllViewed);

  // The focus the guide had when the tab opened is where the reader already
  // was; only a move made from here on opens a diff.
  const handled = useRef<number | null>(null);
  const settled = useRef(false);
  const openTab = useRef(ctx.openTab);
  openTab.current = ctx.openTab;
  useEffect(() => {
    if (guide.loading) return;
    if (!settled.current) {
      settled.current = true;
      handled.current = guide.focus?.nonce ?? null;
      return;
    }
    const spec = guideFocusTab(ctx.pr.id, guide.focus, handled.current);
    if (!spec) return;
    handled.current = guide.focus?.nonce ?? null;
    openTab.current(spec);
  }, [guide.focus, guide.loading, ctx.pr.id]);

  if (guide.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the guide…" />
      </div>
    );
  }

  if (!guide.guide) {
    return (
      <div className="space-y-3 p-4 text-sm text-zinc-400">
        <p>
          A guided review reads the change and works out an order to read it in, with a note at each
          stop on why it comes there.
        </p>
        <PrGuideStart guide={guide} />
        {guide.error && !guide.generating && <p className="text-xs text-red-400">{guide.error}</p>}
      </div>
    );
  }

  const { steps, currentStep } = guide.guide;
  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <ol className="w-72 shrink-0 space-y-0.5 overflow-y-auto text-xs">
        {steps.map((step, i) => {
          const done = stepPaths(step).every((p) => viewed.viewed.has(p));
          return (
            // A step is its place in the tour: the same file can be two stops.
            // biome-ignore lint/suspicious/noArrayIndexKey: steps never reorder
            <li key={i}>
              <button
                type="button"
                onClick={() => guide.goTo(i)}
                aria-current={i === currentStep ? "step" : undefined}
                className={`flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800 ${
                  i === currentStep ? "bg-zinc-800 text-zinc-100" : "text-zinc-400"
                }`}
              >
                <span className={`w-5 shrink-0 text-right ${done ? "text-emerald-500" : ""}`}>
                  {done ? "✓" : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-mono" title={stepLocation(step)}>
                    {stepLocation(step)}
                  </span>
                  {step.kind && step.kind !== "walkthrough" && (
                    <span className="text-[11px] text-zinc-500">{step.kind} check</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <PrGuidePanel guide={guide} inline />
      </div>
    </div>
  );
}
