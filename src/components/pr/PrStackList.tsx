import { requestOpenPr } from "../../lib/nav";
import { refKey } from "../../lib/pr/ref";
import { hasPullRequest } from "../../lib/pr/stack";
import type { PrStack, PrSummary, StackEntry } from "../../lib/pr/types";
import { stackEntryBadge } from "../../lib/prGlance";
import { openExternal } from "../../lib/url";

/**
 * Builds the summary the PRs tab needs to open a layer. The fields the stack
 * doesn't carry are left empty: the review view refetches the detail anyway, so
 * the only visible gap is a blank title for as long as that takes.
 */
function toSummary(entry: StackEntry): PrSummary {
  return {
    ref: entry.ref,
    title: entry.title,
    url: entry.url,
    author: "",
    draft: entry.draft,
    state: entry.state,
    createdAt: "",
    updatedAt: "",
  };
}

function StackRow({
  entry,
  isLast,
  onOpen,
}: {
  entry: StackEntry;
  /** The bottom layer: nothing of the stack is drawn below it. */
  isLast: boolean;
  onOpen?: (entry: StackEntry) => void;
}) {
  const badge = stackEntryBadge(entry);
  const openable = hasPullRequest(entry);
  return (
    <li className="flex items-start gap-2">
      {/* The connector: a stub of the line down to the layer below, so the
          chain reads as one thing rather than as a list of rows. */}
      <div className="flex w-3 shrink-0 flex-col items-center pt-1.5">
        <span className={`text-[10px] leading-none ${badge.className}`}>{badge.icon}</span>
        {!isLast && <span className="mt-0.5 w-px flex-1 bg-zinc-700" />}
      </div>

      <div
        className={`min-w-0 flex-1 rounded px-2 py-1 ${
          entry.isCurrent ? "bg-zinc-800/80 ring-1 ring-indigo-500/40" : "hover:bg-zinc-800/40"
        }`}
      >
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            disabled={!openable}
            onClick={() => onOpen?.(entry)}
            title={openable ? `Review #${entry.number} in yarvis` : "This branch has no PR yet"}
            className="min-w-0 flex-1 truncate text-left text-xs text-zinc-200 disabled:cursor-default disabled:text-zinc-500"
          >
            {openable && <span className="mr-1 font-mono text-zinc-500">#{entry.number}</span>}
            {entry.title || entry.headRef}
          </button>
          {entry.url && (
            <button
              type="button"
              onClick={() => openExternal(entry.url)}
              title={`Open #${entry.number} on GitHub`}
              className="shrink-0 text-xs text-zinc-500 hover:text-zinc-300"
            >
              ↗
            </button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
          <span className={badge.className}>{badge.status}</span>
          <span className="truncate font-mono">{entry.headRef}</span>
          {entry.needsUpdate && (
            <span className="text-amber-400" title="The layer below has moved since this branch">
              needs restack
            </span>
          )}
          {entry.isCurrent && <span className="text-indigo-300">you are here</span>}
        </div>
      </div>
    </li>
  );
}

/**
 * A stack of pull requests, top (furthest from the trunk) first.
 *
 * Drawn top-down rather than bottom-up because that is how a stack is drawn
 * everywhere else — GitHub's own view, `gh stack view`, the diagrams people
 * sketch — even though the trunk is the anchor and the sidecar hands the list
 * over bottom-first. The trunk is pinned underneath as the floor.
 */
export default function PrStackList({
  stack,
  onOpen = (entry) => requestOpenPr(toSummary(entry)),
}: {
  stack: PrStack;
  /** What clicking a layer does. Defaults to opening it in the PRs tab. */
  onOpen?: (entry: StackEntry) => void;
}) {
  const topDown = [...stack.entries].reverse();
  // The branch the bottom layer actually targets, which for a stack rooted
  // somewhere other than the default branch is not `trunk`.
  const floor = stack.entries[0]?.baseRef || stack.trunk;
  return (
    <div className="space-y-1">
      <ul className="space-y-0.5">
        {topDown.map((entry, i) => (
          <StackRow
            key={hasPullRequest(entry) ? refKey(entry.ref) : `branch:${entry.headRef}`}
            entry={entry}
            isLast={i === topDown.length - 1}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <div className="flex items-center gap-2 pl-1 text-[11px] text-zinc-500">
        <span className="w-3 text-center">└</span>
        <span className="font-mono">{floor}</span>
      </div>
    </div>
  );
}
