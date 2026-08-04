import type { GuideController } from "./usePrGuide";

/** Renders a step's line range as "src/a.ts:12–40", or just the path. */
export function stepLocation(step: {
  path: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (step.startLine == null) return step.path;
  const range = step.endLine && step.endLine !== step.startLine ? `–${step.endLine}` : "";
  return `${step.path}:${step.startLine}${range}`;
}

/**
 * The guided-review box: where the reader is in the tour, why this code comes
 * here, and the controls to move.
 *
 * It floats over the bottom of the review pane rather than sitting in the page
 * flow, because advancing a step scrolls the diff underneath it — a box that
 * scrolled away with the content would leave the reader with no way forward
 * without scrolling back to find it.
 */
export default function PrGuidePanel({ guide: controller }: { guide: GuideController }) {
  const { guide, step } = controller;
  if (!guide || !step) return null;

  const position = guide.currentStep;
  const total = guide.steps.length;
  const atStart = position === 0;
  const atEnd = position === total - 1;

  return (
    <div className="pointer-events-none sticky bottom-0 z-20 flex justify-end pb-4">
      <div className="pointer-events-auto w-[420px] max-w-full rounded-lg border border-sky-800 bg-zinc-900 shadow-xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <span className="font-medium text-sky-300">Guided review</span>
          <span className="text-zinc-500">
            Step {position + 1} of {total}
          </span>
          {guide.stale && (
            <span
              title={`Generated against ${guide.headSha.slice(0, 7)}; the pull request has moved since.`}
              className="rounded border border-amber-700 px-1.5 py-0.5 text-[11px] text-amber-300"
            >
              Out of date
            </span>
          )}
          <button
            type="button"
            onClick={() => void controller.generate()}
            disabled={controller.generating}
            className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          >
            {controller.generating ? "Rebuilding…" : "Regenerate"}
          </button>
          <button
            type="button"
            onClick={() => void controller.dismiss()}
            title="End the guided review"
            aria-label="End the guided review"
            className="rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="space-y-2 px-3 py-2">
          <button
            type="button"
            onClick={() => controller.goTo(position)}
            title="Jump back to this code"
            className="block max-w-full truncate font-mono text-xs text-sky-400 hover:text-sky-300"
          >
            {stepLocation(step)}
          </button>
          <p className="text-sm text-zinc-200">{step.explanation}</p>
          {step.context && (
            <details className="group">
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
                <span className="inline-block transition-transform group-open:rotate-90">▶</span>{" "}
                More context
              </summary>
              <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-400">{step.context}</p>
            </details>
          )}
          {controller.error && <p className="text-xs text-red-400">{controller.error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-zinc-800 px-3 py-2">
          <button
            type="button"
            onClick={controller.back}
            disabled={atStart}
            className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="button"
            onClick={controller.next}
            disabled={atEnd}
            className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-40"
          >
            Next
          </button>
          {atEnd && <span className="text-xs text-zinc-500">End of the tour</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * The entry point when a pull request has no guide yet. Kept separate from the
 * panel so the review shows one control or the other, never a box explaining
 * that it is empty.
 */
export function PrGuideStart({ guide: controller }: { guide: GuideController }) {
  if (controller.loading || controller.guide) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        onClick={() => void controller.generate()}
        disabled={controller.generating}
        className="rounded border border-sky-800 px-2 py-0.5 text-sky-300 hover:bg-sky-900/40 disabled:opacity-50"
      >
        {controller.generating ? "Working out a reading order…" : "Guided review"}
      </button>
      {controller.generating && (
        <span className="text-zinc-500">
          Reading the change to work out where to start — this takes a minute.
        </span>
      )}
      {controller.error && <span className="text-red-400">{controller.error}</span>}
    </div>
  );
}
