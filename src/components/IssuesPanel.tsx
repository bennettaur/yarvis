import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addIssueStar,
  createIssueFilter,
  deleteIssueFilter,
  issueFilters,
  issueLinks,
  issueStars,
  issuesAll,
  issuesAssigned,
  issuesRepos,
  issuesSearch,
  removeIssueStar,
} from "../lib/issues/api";
import { type IssueFilter, type IssueLink, type IssueSummary, issueKey } from "../lib/issues/types";
import { useOmniChatContext } from "../lib/omniChatContext";
import { formatRelativeTime } from "../lib/time";
import { openExternal } from "../lib/url";
import IssueDetailView from "./issue/IssueDetailView";

type TabKey = "assigned" | "all" | "filters";

const TABS: { key: TabKey; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "all", label: "All open" },
  { key: "filters", label: "Filters" },
];

function createdMs(issue: IssueSummary): number {
  return new Date(issue.createdAt).getTime() || 0;
}

/** Groups issues by their source (repo), newest-first within and across groups. */
function groupBySource(issues: IssueSummary[]): { label: string; issues: IssueSummary[] }[] {
  const map = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    const list = map.get(issue.sourceLabel);
    if (list) list.push(issue);
    else map.set(issue.sourceLabel, [issue]);
  }
  const groups = [...map.entries()].map(([label, items]) => ({
    label,
    issues: items.sort((a, b) => createdMs(b) - createdMs(a)),
  }));
  groups.sort((a, b) => createdMs(b.issues[0]!) - createdMs(a.issues[0]!));
  return groups;
}

/** A colored label pill; uses the label's own hex color when GitHub provides one. */
function LabelPill({ name, color }: { name: string; color: string | null }) {
  // `22` is the alpha byte (~13%) for a faint tinted background behind the text.
  const style = color ? { backgroundColor: `#${color}22`, color: `#${color}` } : undefined;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] ${color ? "" : "bg-zinc-800 text-zinc-400"}`}
      style={style}
    >
      {name}
    </span>
  );
}

function IssueRow({
  issue,
  starred,
  link,
  onToggleStar,
  onOpen,
}: {
  issue: IssueSummary;
  starred: boolean;
  link: IssueLink | undefined;
  onToggleStar: (issue: IssueSummary, starred: boolean) => void;
  onOpen: (issue: IssueSummary) => void;
}) {
  return (
    <li
      onClick={() => onOpen(issue)}
      className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-zinc-800/50"
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(issue, starred);
        }}
        className={starred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-400"}
        title={starred ? "Unstar" : "Star"}
      >
        ★
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-zinc-100">{issue.title}</span>
          {issue.labels.slice(0, 3).map((l) => (
            <LabelPill key={l.name} name={l.name} color={l.color} />
          ))}
        </div>
        <div className="text-xs text-zinc-500">
          {issue.displayId} · {issue.author} · opened {formatRelativeTime(issue.createdAt)}
          {issue.commentCount > 0 && ` · ${issue.commentCount} 💬`}
        </div>
      </div>
      {link?.localStatus === "in_progress" && (
        <span className="shrink-0 rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-200">
          in progress
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          openExternal(issue.url);
        }}
        className="shrink-0 text-zinc-600 hover:text-sky-400"
        title="Open externally"
      >
        ↗
      </button>
    </li>
  );
}

/** Renders issues grouped under source (repo) headers, newest-first. */
function IssueGroupedList({
  issues,
  isStarred,
  linkFor,
  onToggleStar,
  onOpen,
  emptyText,
}: {
  issues: IssueSummary[];
  isStarred: (issue: IssueSummary) => boolean;
  linkFor: (issue: IssueSummary) => IssueLink | undefined;
  onToggleStar: (issue: IssueSummary, starred: boolean) => void;
  onOpen: (issue: IssueSummary) => void;
  emptyText: string;
}) {
  const groups = useMemo(() => groupBySource(issues), [issues]);
  if (issues.length === 0) return <p className="text-sm text-zinc-600">{emptyText}</p>;
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mb-2 text-sm font-medium text-zinc-300">
            {group.label}
            <span className="ml-2 text-xs text-zinc-600">({group.issues.length})</span>
          </h3>
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {group.issues.map((issue) => (
              <IssueRow
                key={issue.url}
                issue={issue}
                starred={isStarred(issue)}
                link={linkFor(issue)}
                onToggleStar={onToggleStar}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function IssuesPanel() {
  const [activeTab, setActiveTab] = useState<TabKey>("assigned");
  const [assigned, setAssigned] = useState<IssueSummary[]>([]);
  const [all, setAll] = useState<IssueSummary[]>([]);
  const [starredKeys, setStarredKeys] = useState<Set<string>>(new Set());
  const [links, setLinks] = useState<Map<string, IssueLink>>(new Map());
  const [filters, setFilters] = useState<IssueFilter[]>([]);
  const [filterResults, setFilterResults] = useState<IssueSummary[] | null>(null);
  const [newFilter, setNewFilter] = useState({ name: "", query: "" });
  const [selected, setSelected] = useState<IssueSummary | null>(null);
  const [configuredCount, setConfiguredCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useOmniChatContext("issues", () => {
    if (selected) {
      return {
        source: "issues",
        summary: `Viewing issue ${selected.displayId} "${selected.title}" in ${selected.sourceLabel}`,
        details: { url: selected.url, author: selected.author },
      };
    }
    const count = activeTab === "assigned" ? assigned.length : activeTab === "all" ? all.length : 0;
    return { source: "issues", summary: `On the Issues tab (${activeTab} list, ${count} shown)` };
  }, [selected, activeTab, assigned.length, all.length]);

  const loadStars = useCallback(async () => {
    const stars = await issueStars();
    setStarredKeys(new Set(stars.map((s) => issueKey(s.provider, s.sourceKey, s.externalId))));
  }, []);

  const loadLinks = useCallback(async () => {
    const rows = await issueLinks();
    setLinks(new Map(rows.map((l) => [issueKey(l.provider, l.sourceKey, l.externalId), l])));
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const repos = await issuesRepos();
      setConfiguredCount(repos.length);
      if (repos.length === 0) return;
      const [assignedList, allList] = await Promise.all([issuesAssigned(), issuesAll()]);
      setAssigned(assignedList);
      setAll(allList);
      setFilters(await issueFilters());
      await loadStars();
      await loadLinks();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadStars, loadLinks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggleStar = useCallback(
    async (issue: IssueSummary, starred: boolean) => {
      if (starred) await removeIssueStar(issue);
      else await addIssueStar(issue);
      await loadStars();
    },
    [loadStars],
  );

  const isStarred = useCallback(
    (issue: IssueSummary) =>
      starredKeys.has(issueKey(issue.provider, issue.sourceKey, issue.externalId)),
    [starredKeys],
  );
  const linkFor = useCallback(
    (issue: IssueSummary) => links.get(issueKey(issue.provider, issue.sourceKey, issue.externalId)),
    [links],
  );

  const runFilter = useCallback(async (query: string) => {
    setFilterResults(await issuesSearch(query));
  }, []);

  const addFilter = useCallback(async () => {
    if (!newFilter.name.trim() || !newFilter.query.trim()) return;
    await createIssueFilter(newFilter.name.trim(), newFilter.query.trim());
    setNewFilter({ name: "", query: "" });
    setFilters(await issueFilters());
  }, [newFilter]);

  if (selected) {
    return (
      <IssueDetailView
        summary={selected}
        onBack={() => setSelected(null)}
        onStarted={() => void loadLinks()}
      />
    );
  }

  if (configuredCount === 0) {
    return (
      <div className="h-full overflow-y-auto p-6">
        <p className="text-sm text-zinc-400">
          No repositories are set to pull issues. Enable “Pull issues” on a repo in Settings →
          Repositories to see its issues here.
        </p>
      </div>
    );
  }

  const listProps = { isStarred, linkFor, onToggleStar, onOpen: setSelected };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="space-y-5">
        <nav className="flex gap-1 border-b border-zinc-800">
          {TABS.map((t) => {
            const count =
              t.key === "assigned" ? assigned.length : t.key === "all" ? all.length : null;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  activeTab === t.key
                    ? "border-sky-500 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t.label}
                {count !== null && <span className="ml-1.5 text-xs text-zinc-600">{count}</span>}
              </button>
            );
          })}
        </nav>

        {activeTab === "assigned" && (
          <IssueGroupedList
            issues={assigned}
            emptyText="No issues assigned to you in the configured repos."
            {...listProps}
          />
        )}
        {activeTab === "all" && (
          <IssueGroupedList
            issues={all}
            emptyText="No open issues in the configured repos."
            {...listProps}
          />
        )}

        {activeTab === "filters" && (
          <div className="space-y-5">
            <section>
              <div className="mb-3 flex flex-wrap gap-2">
                {filters.map((f) => (
                  <span
                    key={f.id}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs"
                  >
                    <button onClick={() => void runFilter(f.query)} className="hover:text-zinc-100">
                      {f.name}
                    </button>
                    <button
                      onClick={async () => {
                        await deleteIssueFilter(f.id);
                        setFilters(await issueFilters());
                      }}
                      className="text-zinc-600 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={newFilter.name}
                  placeholder="Filter name"
                  onChange={(e) => setNewFilter((p) => ({ ...p, name: e.target.value }))}
                  className="w-32 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <input
                  value={newFilter.query}
                  placeholder="is:open is:issue label:bug ..."
                  onChange={(e) => setNewFilter((p) => ({ ...p, query: e.target.value }))}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <button
                  onClick={() => void addFilter()}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
            </section>
            {filterResults && (
              <IssueGroupedList issues={filterResults} emptyText="No matches." {...listProps} />
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
