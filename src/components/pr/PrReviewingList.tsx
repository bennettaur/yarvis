import { useMemo } from "react";
import type { PrInvolvement, PrSummary, ReviewingList } from "../../lib/pr/types";
import PrGroupedList, { type PrListProps, type PrRowNote } from "./PrGroupedList";

/**
 * Reviews the user has started: PRs they've opened in yarvis, commented on, or
 * reviewed on GitHub. Split so the work still owed is what they see, and the
 * finished half — merged, closed, or approved by them — starts collapsed.
 */

/** Explains why a PR counts as done, or what the user last said on it. */
function involvementNote(item: PrInvolvement): string | null {
  if (item.merged) return "merged";
  if (item.summary.state === "closed") return "closed";
  const last = item.myReviewStates[item.myReviewStates.length - 1];
  if (last === "approved") return "you approved";
  if (last === "changes_requested") return "you requested changes";
  if (last === "commented") return "you commented";
  return null;
}

/** Indexes notes by PR url so the grouped list can annotate rows by summary. */
function noteLookup(items: PrInvolvement[]): PrRowNote {
  const byUrl = new Map(items.map((item) => [item.summary.url, involvementNote(item)]));
  return (pr: PrSummary) => byUrl.get(pr.url) ?? null;
}

function Half({
  title,
  items,
  defaultOpen,
  listProps,
}: {
  title: string;
  items: PrInvolvement[];
  defaultOpen: boolean;
  listProps: PrListProps;
}) {
  const summaries = useMemo(() => items.map((item) => item.summary), [items]);
  const note = useMemo(() => noteLookup(items), [items]);
  return (
    <details open={defaultOpen} className="group">
      <summary className="mb-3 flex cursor-pointer items-center gap-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        <span className="text-zinc-600 transition-transform group-open:rotate-90">▶</span>
        {title}
        <span className="font-normal text-zinc-600">({items.length})</span>
      </summary>
      <PrGroupedList prs={summaries} note={note} {...listProps} />
    </details>
  );
}

export default function PrReviewingList({
  list,
  listProps,
}: {
  list: ReviewingList;
  listProps: PrListProps;
}) {
  return (
    <div className="space-y-5">
      <Half title="In progress" items={list.inProgress} defaultOpen={true} listProps={listProps} />
      <Half title="Complete" items={list.complete} defaultOpen={false} listProps={listProps} />
    </div>
  );
}
