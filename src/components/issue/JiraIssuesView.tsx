import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addIssueStar,
  createIssueFilter,
  deleteIssueFilter,
  issueFilters,
  issueLinks,
  issueStars,
  removeIssueStar,
} from "../../lib/issues/api";
import {
  type IssueFilter,
  type IssueLink,
  type IssueStar,
  type IssueSummary,
  issueKey,
} from "../../lib/issues/types";
import { jiraAssigned, jiraCreated, jiraSearch } from "../../lib/jira/api";
import { openExternal } from "../../lib/url";
import JiraCreateIssueModal from "./JiraCreateIssueModal";
import JiraIssueDetailView from "./JiraIssueDetailView";
import { StatusBadge } from "./jiraStatus";

type TabKey = "assigned" | "created" | "search" | "starred";

const TABS: { key: TabKey; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "created", label: "Created by me" },
  { key: "search", label: "Search" },
  { key: "starred", label: "Starred" },
];

/** A bare JIRA issue key like "PROJ-45", used to detect key lookups vs JQL. */
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/** Rank JIRA status categories so grouped sections read to-do → in-progress → done. */
function categoryRank(category: string | undefined): number {
  if (category === "in_progress") return 1;
  if (category === "done") return 2;
  return 0;
}

interface StatusGroup {
  status: string;
  category: string | undefined;
  issues: IssueSummary[];
}
interface ProjectGroup {
  project: string;
  issues: IssueSummary[];
  statuses: StatusGroup[];
}

/** Groups issues by project (sourceLabel), then by status within each project. */
function groupByProjectAndStatus(issues: IssueSummary[]): ProjectGroup[] {
  const byProject = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    const list = byProject.get(issue.sourceLabel);
    if (list) list.push(issue);
    else byProject.set(issue.sourceLabel, [issue]);
  }
  const projects = [...byProject.entries()].map(([project, projIssues]) => {
    const byStatus = new Map<string, StatusGroup>();
    for (const issue of projIssues) {
      const name = issue.statusName ?? "No status";
      const group = byStatus.get(name);
      if (group) group.issues.push(issue);
      else byStatus.set(name, { status: name, category: issue.statusCategory, issues: [issue] });
    }
    const statuses = [...byStatus.values()].sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) || a.status.localeCompare(b.status),
    );
    return { project, issues: projIssues, statuses };
  });
  projects.sort((a, b) => a.project.localeCompare(b.project));
  return projects;
}

function JiraIssueRow({
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
  const assignee = issue.assignees[0];
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
            <span
              key={l.name}
              className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-400"
            >
              {l.name}
            </span>
          ))}
        </div>
        <div className="text-xs text-zinc-500">
          {issue.displayId}
          {issue.issueType && ` · ${issue.issueType}`} · {issue.author || "no reporter"}
          {assignee ? ` → ${assignee}` : " → unassigned"}
        </div>
      </div>
      <StatusBadge name={issue.statusName ?? ""} category={issue.statusCategory} />
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
        title="Open in JIRA"
      >
        ↗
      </button>
    </li>
  );
}

function GroupedList({
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
  const groups = useMemo(() => groupByProjectAndStatus(issues), [issues]);
  if (issues.length === 0) return <p className="text-sm text-zinc-600">{emptyText}</p>;
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.project}>
          <h3 className="mb-2 text-sm font-medium text-zinc-300">
            {group.project}
            <span className="ml-2 text-xs text-zinc-600">({group.issues.length})</span>
          </h3>
          <div className="space-y-3">
            {group.statuses.map((s) => (
              <div key={s.status}>
                <div className="mb-1 flex items-center gap-2 px-1">
                  <StatusBadge name={s.status} category={s.category} />
                  <span className="text-xs text-zinc-600">{s.issues.length}</span>
                </div>
                <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
                  {s.issues.map((issue) => (
                    <JiraIssueRow
                      key={issue.externalId}
                      issue={issue}
                      starred={isStarred(issue)}
                      link={linkFor(issue)}
                      onToggleStar={onToggleStar}
                      onOpen={onOpen}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The JIRA issues view: sub-tabs for issues assigned to / created by the user,
 * a JQL/key search, and starred issues — all grouped by project and status.
 * Rows open the JIRA detail view. A "New issue" button opens the create dialog.
 * Shown when the Issues panel's provider toggle is set to JIRA.
 */
export default function JiraIssuesView() {
  const [activeTab, setActiveTab] = useState<TabKey>("assigned");
  const [assigned, setAssigned] = useState<IssueSummary[]>([]);
  const [created, setCreated] = useState<IssueSummary[]>([]);
  const [stars, setStars] = useState<IssueStar[]>([]);
  const [starredIssues, setStarredIssues] = useState<IssueSummary[]>([]);
  const [links, setLinks] = useState<Map<string, IssueLink>>(new Map());
  const [filters, setFilters] = useState<IssueFilter[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<IssueSummary[] | null>(null);
  const [newFilterName, setNewFilterName] = useState("");
  const [selected, setSelected] = useState<IssueSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [notConfigured, setNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const starredKeys = useMemo(
    () => new Set(stars.map((s) => issueKey(s.provider, s.sourceKey, s.externalId))),
    [stars],
  );

  const loadStars = useCallback(async () => {
    setStars(await issueStars("jira"));
  }, []);

  const loadLinks = useCallback(async () => {
    const rows = await issueLinks("jira");
    setLinks(new Map(rows.map((l) => [issueKey(l.provider, l.sourceKey, l.externalId), l])));
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    setNotConfigured(false);
    setLoading(true);
    try {
      const [assignedList, createdList] = await Promise.all([jiraAssigned(), jiraCreated()]);
      setAssigned(assignedList);
      setCreated(createdList);
      setFilters(await issueFilters("jira"));
      await loadStars();
      await loadLinks();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // The gate returns a 400 "jira not configured" when secrets are missing.
      if (/not configured/i.test(msg)) setNotConfigured(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [loadStars, loadLinks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Resolve starred issues to full rows (status/labels/assignee) via one JQL.
  useEffect(() => {
    if (activeTab !== "starred") return;
    const keys = stars.map((s) => s.externalId).filter((k) => ISSUE_KEY_RE.test(k));
    if (keys.length === 0) {
      setStarredIssues([]);
      return;
    }
    let live = true;
    jiraSearch(`issuekey in (${keys.join(",")}) ORDER BY updated DESC`)
      .then((rows) => live && setStarredIssues(rows))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeTab, stars]);

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

  const runSearch = useCallback(async (jql: string) => {
    setSearchResults(await jiraSearch(jql));
  }, []);

  const onSubmitSearch = useCallback(() => {
    const text = searchText.trim();
    if (!text) return;
    // A bare issue key opens that issue directly; anything else is JQL.
    if (ISSUE_KEY_RE.test(text)) {
      const projectKey = text.replace(/-\d+$/, "");
      setSelected({
        provider: "jira",
        sourceKey: projectKey,
        sourceLabel: projectKey,
        externalId: text.toUpperCase(),
        displayId: text.toUpperCase(),
        title: text.toUpperCase(),
        url: "",
        state: "open",
        author: "",
        assignees: [],
        labels: [],
        createdAt: "",
        updatedAt: "",
        commentCount: 0,
      });
      return;
    }
    void runSearch(text).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [searchText, runSearch]);

  const saveFilter = useCallback(async () => {
    if (!newFilterName.trim() || !searchText.trim()) return;
    await createIssueFilter(newFilterName.trim(), searchText.trim(), "jira");
    setNewFilterName("");
    setFilters(await issueFilters("jira"));
  }, [newFilterName, searchText]);

  if (selected) {
    return (
      <JiraIssueDetailView
        summary={selected}
        onBack={() => setSelected(null)}
        onStarted={() => void loadLinks()}
      />
    );
  }

  if (notConfigured) {
    return (
      <div className="p-6">
        <p className="text-sm text-zinc-400">
          JIRA isn’t configured. Add your JIRA base URL, email, and API token in Settings →
          Credentials to see your issues here.
        </p>
      </div>
    );
  }

  const listProps = { isStarred, linkFor, onToggleStar, onOpen: setSelected };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="space-y-5">
        <div className="flex items-center justify-between">
          <nav className="flex gap-1 border-b border-zinc-800">
            {TABS.map((t) => {
              const count =
                t.key === "assigned"
                  ? assigned.length
                  : t.key === "created"
                    ? created.length
                    : t.key === "starred"
                      ? stars.length
                      : null;
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
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
          >
            + New issue
          </button>
        </div>

        {loading && <p className="text-sm text-zinc-600">Loading…</p>}

        {activeTab === "assigned" && !loading && (
          <GroupedList
            issues={assigned}
            emptyText="No open issues assigned to you."
            {...listProps}
          />
        )}
        {activeTab === "created" && !loading && (
          <GroupedList
            issues={created}
            emptyText="No open issues reported by you."
            {...listProps}
          />
        )}
        {activeTab === "starred" && !loading && (
          <GroupedList issues={starredIssues} emptyText="No starred issues." {...listProps} />
        )}

        {activeTab === "search" && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSubmitSearch()}
                placeholder="JQL, e.g. project = PROJ AND status = 'In Progress' — or an issue key like PROJ-45"
                className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
              />
              <button
                type="button"
                onClick={onSubmitSearch}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
              >
                Search
              </button>
            </div>

            {filters.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {filters.map((f) => (
                  <span
                    key={f.id}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs"
                  >
                    <button
                      onClick={() => {
                        setSearchText(f.query);
                        void runSearch(f.query);
                      }}
                      className="hover:text-zinc-100"
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={async () => {
                        await deleteIssueFilter(f.id, "jira");
                        setFilters(await issueFilters("jira"));
                      }}
                      className="text-zinc-600 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            {searchResults && (
              <div className="space-y-3">
                <div className="flex gap-2">
                  <input
                    value={newFilterName}
                    placeholder="Save this JQL as…"
                    onChange={(e) => setNewFilterName(e.target.value)}
                    className="w-48 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void saveFilter()}
                    disabled={!newFilterName.trim() || !searchText.trim()}
                    className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
                  >
                    Save filter
                  </button>
                </div>
                <GroupedList issues={searchResults} emptyText="No matches." {...listProps} />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>

      {creating && (
        <JiraCreateIssueModal onClose={() => setCreating(false)} onCreated={() => void refresh()} />
      )}
    </div>
  );
}
