import { type ReactNode, useMemo } from "react";
import { CodeText, rowClass } from "../../../src/components/diff/DiffRow";
import PrGuidePanel from "../../../src/components/pr/PrGuidePanel";
import type { GuideController } from "../../../src/components/pr/usePrGuide";
import { parsePatch } from "../../../src/lib/pr/diff";
import type { PrGuideStep } from "../../../src/lib/pr/guide";
import { highlightDiff, rowHtml } from "../../../src/lib/pr/highlight";
import { asyncNoop, noop } from "../lib/style";

/** A guide controller with nothing behind it: the panel only reads `guide` and `step`. */
export function staticGuide(steps: PrGuideStep[], current: number): GuideController {
  return {
    guide: { headSha: "a1b2c3d", steps, currentStep: current, stale: false, createdAt: "" },
    step: steps[current],
    loading: false,
    generating: false,
    error: null,
    generate: asyncNoop,
    next: noop,
    back: noop,
    goTo: noop,
    focusOn: noop,
    dismiss: asyncNoop,
    focus: null,
    finish: asyncNoop,
  };
}

/** Inset left bar the guided review draws on the lines a step is about. */
const FOCUS_STYLE = { boxShadow: "inset 3px 0 0 0 #38bdf8" };

/** A unified diff of one file, from the app's patch parser, highlighter and row styles. */
export function DiffFile({
  path,
  patch,
  add,
  del,
  focus,
  below,
}: {
  path: string;
  patch: string;
  add: number;
  del: number;
  /** New-file line range the guide is pointing at. */
  focus?: { start: number; end: number } | null;
  /** Rendered under the row for this new-file line, as insights are. */
  below?: { line: number; node: ReactNode };
}) {
  // The patch is fixed, so parse and highlight it once rather than every frame.
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const highlight = useMemo(() => highlightDiff(rows, path), [rows, path]);
  return (
    <div className="border border-zinc-800">
      <div className="flex items-center gap-2 bg-zinc-900 px-3 py-2 text-sm">
        <span className="min-w-0 truncate font-mono text-zinc-200">{path}</span>
        <span className="text-xs text-emerald-400">+{add}</span>
        <span className="text-xs text-red-400">−{del}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-700 px-2.5 py-0.5 text-xs font-medium text-zinc-400">
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-zinc-600" />
          Viewed
        </span>
      </div>
      <div className="relative overflow-hidden bg-zinc-950 font-mono text-xs leading-relaxed">
        {rows.map((row, i) => {
          const line = row.rightLine;
          const marked =
            focus != null &&
            line !== null &&
            line >= focus.start &&
            line <= focus.end &&
            row.kind !== "del";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows of a fixed patch
            <div key={i}>
              <div
                className={`flex ${rowClass(row.kind)}`}
                style={marked ? FOCUS_STYLE : undefined}
              >
                <span className="relative flex w-12 shrink-0 select-none items-center justify-end pr-2 text-zinc-600">
                  {row.kind === "del" ? "" : (line ?? "")}
                </span>
                <CodeText html={rowHtml(row, highlight)} text={row.text} />
              </div>
              {below && line === below.line && row.kind !== "del" && (
                <div className="space-y-2 px-3 py-2 font-sans">{below.node}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const ACTION_CLASS = "rounded-md px-3 py-1.5 text-xs font-medium text-white shadow-sm";

/**
 * A PR's review page from `PrDetailView`'s markup: the pinned header, the
 * file list beside the diffs, and the real `PrGuidePanel` pinned to the bottom.
 */
export function PrReviewView({
  title,
  number,
  repo,
  files,
  viewed,
  selected,
  children,
  guide,
}: {
  title: string;
  number: number;
  repo: string;
  files: { path: string; change: "A" | "M"; add: number; del: number }[];
  viewed: number;
  selected: string;
  children: ReactNode;
  guide: GuideController | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-800 bg-[#0a0a0a] px-6 py-3">
        <div className="flex items-center gap-3">
          <span className="rounded-md border border-zinc-700 px-2 py-1 text-sm">← Back</span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-zinc-600">★</span>
              <h2 className="min-w-0 truncate text-base font-semibold text-zinc-100">
                {title} <span className="font-normal text-zinc-500">#{number}</span>
              </h2>
            </div>
            <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
              <span className="truncate">{repo}</span>
            </div>
          </div>
          <span className="shrink-0 rounded bg-amber-900/40 px-2 py-0.5 text-xs font-medium text-amber-200">
            Awaiting review
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`${ACTION_CLASS} bg-emerald-600`}>Approve</span>
            <span className={`${ACTION_CLASS} bg-red-600`}>Request changes</span>
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden px-6">
        <div className="space-y-3 py-4">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Files</h3>
          </div>
          <div className="flex gap-4">
            <div className="w-56 shrink-0">
              <div className="mb-1 flex items-center gap-2 px-2 text-xs text-zinc-500">
                {viewed}/{files.length} viewed
              </div>
              {files.map((file, i) => (
                <div
                  key={file.path}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 ${
                    file.path === selected ? "bg-zinc-800" : ""
                  } ${i < viewed ? "opacity-60" : ""}`}
                >
                  <span
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center border text-[9px] ${
                      i < viewed
                        ? "border-emerald-500 bg-emerald-500 text-zinc-950"
                        : "border-zinc-600"
                    }`}
                  >
                    {i < viewed ? "✓" : ""}
                  </span>
                  <span
                    className={`font-mono text-xs ${file.change === "A" ? "text-emerald-400" : "text-amber-400"}`}
                  >
                    {file.change}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
                    {file.path.split("/").pop()}
                  </span>
                </div>
              ))}
            </div>
            <div className="min-w-0 flex-1">{children}</div>
          </div>
        </div>
        {guide && (
          <div className="absolute bottom-0 right-6">
            <PrGuidePanel guide={guide} />
          </div>
        )}
      </div>
    </div>
  );
}
