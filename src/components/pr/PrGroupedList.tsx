import { useCallback, useMemo, useState } from "react";
import { usePrStatus } from "../../lib/pr/cache";
import { refDisplayRepo, refNumber } from "../../lib/pr/ref";
import type { PrStatus, PrSummary } from "../../lib/pr/types";
import { formatRelativeTime } from "../../lib/time";
import { openExternal } from "../../lib/url";

/**
 * Which repo groups the user has collapsed, shared by every PR list and
 * persisted so the choice survives switching tabs (each tab's list unmounts) and
 * restarting the app. A repo the user doesn't want to look at is usually a repo
 * they don't want to look at on any list.
 */
const COLLAPSED_STORAGE_KEY = "yarvis.prs.collapsedRepos";

function readCollapsedRepos(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((r) => typeof r === "string")) : new Set();
  } catch {
    // Corrupt or unavailable storage: start expanded; the next toggle rewrites it.
    return new Set();
  }
}

export function useCollapsedRepos(): {
  isCollapsed: (repo: string) => boolean;
  toggle: (repo: string) => void;
} {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedRepos);

  const toggle = useCallback((repo: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(repo)) next.add(repo);
      try {
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Best-effort persistence; the in-session state still reflects the click.
      }
      return next;
    });
  }, []);

  const isCollapsed = useCallback((repo: string) => collapsed.has(repo), [collapsed]);
  return { isCollapsed, toggle };
}

function createdMs(pr: PrSummary): number {
  return new Date(pr.createdAt).getTime() || 0;
}

/** Groups PRs by their display repo, newest-first within each group and across groups. */
export function groupByRepo(prs: PrSummary[]): { repo: string; prs: PrSummary[] }[] {
  const map = new Map<string, PrSummary[]>();
  for (const pr of prs) {
    const key = refDisplayRepo(pr.ref);
    const list = map.get(key);
    if (list) list.push(pr);
    else map.set(key, [pr]);
  }
  const groups = [...map.entries()].map(([repo, items]) => ({
    repo,
    // `items` is a fresh array owned by this function, so sorting in place is safe.
    prs: items.sort((a, b) => createdMs(b) - createdMs(a)),
  }));
  groups.sort((a, b) => createdMs(b.prs[0]!) - createdMs(a.prs[0]!));
  return groups;
}

function DraftBadge() {
  return <span className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-300">draft</span>;
}

/** CI/merge state for a row. Renders nothing while loading or when no signal. */
function StatusBadge({ status }: { status: PrStatus | null }) {
  if (!status) return null;
  let text: string | null = null;
  let color = "";
  if (status.checks.failure > 0) {
    text = "CI failing";
    color = "bg-red-900 text-red-200";
  } else if (status.checks.pending > 0) {
    text = "CI running";
    color = "bg-amber-900 text-amber-200";
  } else if (status.mergeable === false) {
    text = "conflicts";
    color = "bg-red-900 text-red-200";
  } else if (status.checks.total > 0) {
    text = "CI passing";
    color = "bg-emerald-900 text-emerald-200";
  }
  if (!text) return null;
  return <span className={`rounded px-1.5 py-0.5 text-xs ${color}`}>{text}</span>;
}

/** Optional per-row annotation, e.g. the user's own review verdict. */
export type PrRowNote = (pr: PrSummary) => string | null;

function PrRow({
  pr,
  starred,
  note,
  onToggleStar,
  onReview,
}: {
  pr: PrSummary;
  starred: boolean;
  note: string | null;
  onToggleStar: (pr: PrSummary, starred: boolean) => void;
  onReview: (pr: PrSummary) => void;
}) {
  // GitHub's status is one cheap call per row. Azure's only yields `mergeable`
  // at the cost of a full PR-detail fetch per row, so for a list of N PRs that's
  // N heavy calls for little signal — skip it and let the detail view show merge
  // state instead.
  const { data: status } = usePrStatus(pr.ref.provider === "github" ? pr.ref : null);

  return (
    <li
      onClick={() => onReview(pr)}
      className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-zinc-800/50"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(pr, starred);
        }}
        className={starred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-400"}
        title={starred ? "Unstar" : "Star"}
      >
        ★
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-100">{pr.title}</div>
        <div className="text-xs text-zinc-500">
          #{refNumber(pr.ref)} · {pr.author} · opened {formatRelativeTime(pr.createdAt)}
          {note && ` · ${note}`}
        </div>
      </div>
      {pr.draft && <DraftBadge />}
      <StatusBadge status={status} />
      <span className="shrink-0 text-xs text-zinc-600" title={`Updated ${pr.updatedAt}`}>
        {formatRelativeTime(pr.updatedAt)}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openExternal(pr.url);
        }}
        className="shrink-0 text-zinc-600 hover:text-sky-400"
        title="Open externally"
      >
        ↗
      </button>
    </li>
  );
}

export interface PrListProps {
  isStarred: (pr: PrSummary) => boolean;
  onToggleStar: (pr: PrSummary, starred: boolean) => void;
  onReview: (pr: PrSummary) => void;
}

/** Renders PRs grouped under collapsible repo headers, newest-first. */
export default function PrGroupedList({
  prs,
  note,
  isStarred,
  onToggleStar,
  onReview,
}: PrListProps & {
  prs: PrSummary[];
  note?: PrRowNote;
}) {
  const groups = useMemo(() => groupByRepo(prs), [prs]);
  const { isCollapsed, toggle } = useCollapsedRepos();
  if (prs.length === 0) return <p className="text-sm text-zinc-600">None.</p>;
  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const collapsed = isCollapsed(group.repo);
        return (
          <section key={group.repo}>
            <button
              onClick={() => toggle(group.repo)}
              aria-expanded={!collapsed}
              className="mb-2 flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-zinc-100"
            >
              <span className={`text-zinc-600 ${collapsed ? "" : "rotate-90"}`}>▶</span>
              {group.repo}
              <span className="text-xs text-zinc-600">({group.prs.length})</span>
            </button>
            {!collapsed && (
              <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
                {group.prs.map((pr) => (
                  <PrRow
                    key={pr.url}
                    pr={pr}
                    starred={isStarred(pr)}
                    note={note?.(pr) ?? null}
                    onToggleStar={onToggleStar}
                    onReview={onReview}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
