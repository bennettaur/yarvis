import type { PrGuideFindingKind, PrGuideStep, PrGuideStepKind } from "../../lib/pr/guide";
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
 * What a sanity-check step is called in the panel. A walkthrough gets no label:
 * reading the code is what a tour is for, so saying so on every other step is
 * noise.
 */
const KIND_LABEL: Record<PrGuideStepKind, string | null> = {
  walkthrough: null,
  data: "Data sanity check",
  tests: "Test sanity check",
};

/**
 * Read with a fallback at the point of use: a stored guide is jsonb that is not
 * re-validated on the way back, so a row written by a build that knew more
 * kinds than this one still renders a badge.
 */
const FINDING_LABEL: Record<PrGuideFindingKind, string> = {
  "error-handling": "error handling",
  "stale-comment": "stale comment",
  "test-gap": "test gap",
  "brittle-test": "brittle test",
  naming: "naming",
  convention: "convention",
  other: "flagged",
};

/**
 * The problems the agent flagged on this step, each a jump to the line it is
 * about. A finding names a file the step may not point at — a sanity check
 * covers many — so the location travels with the note rather than being assumed
 * from the step.
 */
function Findings({
  step,
  onOpen,
}: {
  step: PrGuideStep;
  onOpen: (path: string, line: number | null) => void;
}) {
  if (!step.findings?.length) return null;
  return (
    <ul className="space-y-1 border-t border-zinc-800 pt-2">
      {step.findings.map((finding) => (
        <li key={`${finding.path}:${finding.startLine}:${finding.note}`} className="text-xs">
          <button
            type="button"
            onClick={() => onOpen(finding.path, finding.startLine)}
            className="block w-full text-left hover:bg-zinc-800/60"
          >
            <span className="mr-1.5 rounded border border-amber-800 px-1 py-0.5 text-[11px] text-amber-300">
              {FINDING_LABEL[finding.kind] ?? "flagged"}
            </span>
            <span className="text-zinc-300">{finding.note}</span>
            <span className="ml-1 font-mono text-[11px] text-zinc-500">
              {stepLocation({ path: finding.path, startLine: finding.startLine, endLine: null })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The other files a step accounted for. Folded away by default: the point of a
 * sanity-check step is that the reader does not have to go through them, so the
 * list is there to be checked rather than read.
 */
function CoveredFiles({ step, onOpen }: { step: PrGuideStep; onOpen: (path: string) => void }) {
  if (!step.covers?.length) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
        <span className="inline-block transition-transform group-open:rotate-90">▶</span> Also
        covers {step.covers.length} file{step.covers.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {step.covers.map((path) => (
          <li key={path}>
            <button
              type="button"
              onClick={() => onOpen(path)}
              className="block max-w-full truncate font-mono text-[11px] text-zinc-400 hover:text-sky-300"
            >
              {path}
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
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
  const kindLabel = KIND_LABEL[step.kind ?? "walkthrough"];

  return (
    <div className="pointer-events-none sticky bottom-0 z-20 flex justify-end pb-4">
      <div className="pointer-events-auto w-[420px] max-w-full rounded-lg border border-sky-800 bg-zinc-900 shadow-xl">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs">
          <span className="font-medium text-sky-300">Guided review</span>
          <span className="text-zinc-500">
            Step {position + 1} of {total}
          </span>
          {kindLabel && (
            <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400">
              {kindLabel}
            </span>
          )}
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
          <CoveredFiles
            step={step}
            onOpen={(path) => controller.focusOn({ path, startLine: null, endLine: null })}
          />
          <Findings
            step={step}
            onOpen={(path, line) => controller.focusOn({ path, startLine: line, endLine: line })}
          />
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
          {/* The last step ends the tour rather than offering a dead Next.
              Finishing is also what credits that step's files as read — with no
              step after it to move past, nothing else would. */}
          {atEnd ? (
            <button
              type="button"
              onClick={() => void controller.finish()}
              className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600"
            >
              Finish
            </button>
          ) : (
            <button
              type="button"
              onClick={controller.next}
              className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600"
            >
              Next
            </button>
          )}
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
