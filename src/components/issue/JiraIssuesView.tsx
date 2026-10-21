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
import { JIRA_ISSUES_PREFIX } from "../../lib/issues/cacheKeys";
import {
  type IssueFilter,
  type IssueLink,
  type IssueStar,
  type IssueSummary,
  issueKey,
} from "../../lib/issues/types";
import { jiraAssigned, jiraCreated, jiraSearch, jiraViewer } from "../../lib/jira/api";
import { useJiraStartWork } from "../../lib/jira/useJiraStartWork";
import { useOmniChatContext } from "../../lib/omniChatContext";
import {
  combineResources,
  invalidatePrefix,
  PROBE_FRESHNESS,
  PROVIDER_FRESHNESS,
  useCachedResource,
} from "../../lib/resourceCache";
import DeleteFilterButton from "../DeleteFilterButton";
import LoadingIndicator from "../LoadingIndicator";
import RefreshingIndicator from "../RefreshingIndicator";
import JiraCreateIssueModal from "./JiraCreateIssueModal";
import JiraIssueDetailView from "./JiraIssueDetailView";
import JiraRepoPickerModal from "./JiraRepoPickerModal";
import StatusGroupedIssueList from "./StatusGroupedIssueList";

type TabKey = "assigned" | "created" | "search" | "starred";

/**
 * Cache keys for the JIRA lists, under the same `issues:` prefix the GitHub
 * view uses so a write that moves both providers' views drops them together.
 */
const VIEWER_KEY = `${JIRA_ISSUES_PREFIX}viewer`;
const ASSIGNED_KEY = `${JIRA_ISSUES_PREFIX}assigned`;
const CREATED_KEY = `${JIRA_ISSUES_PREFIX}created`;
const FILTERS_KEY = `${JIRA_ISSUES_PREFIX}filters`;
const STARS_KEY = `${JIRA_ISSUES_PREFIX}stars`;
const LINKS_KEY = `${JIRA_ISSUES_PREFIX}links`;

/** Stable identities so an unloaded resource doesn't re-render the lists. */
const NO_ISSUES: IssueSummary[] = [];
const NO_STARS: IssueStar[] = [];
const NO_FILTERS: IssueFilter[] = [];

/**
 * The gate answers a 400 "jira not configured" when the secrets are missing.
 * That is a state to explain rather than an error to report, and returning it as
 * data means it is cached like any other answer — a remount of an unconfigured
 * JIRA paints the explanation straight away instead of an empty list first.
 *
 * Anything else is rethrown, and so not cached: JIRA is the only provider this
 * tab can show, so "your credentials are missing" and "JIRA is down" send the
 * user to different places and must not read the same.
 */
async function probeJira(): Promise<{ configured: boolean }> {
  try {
    await jiraViewer();
    return { configured: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/not configured/i.test(message)) return { configured: false };
    throw e;
  }
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "assigned", label: "Assigned to me" },
  { key: "created", label: "Created by me" },
  { key: "search", label: "Search" },
  { key: "starred", label: "Starred" },
];

/** A bare JIRA issue key like "PROJ-45", used to detect key lookups vs JQL. */
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

/**
 * The JIRA issues view: sub-tabs for issues assigned to / created by the user,
 * a JQL/key search, and starred issues — all grouped by project and status.
 * Rows open the JIRA detail view. A "New issue" button opens the create dialog.
 * Shown when the Issues panel's provider toggle is set to JIRA.
 */
export default function JiraIssuesView() {
  const [activeTab, setActiveTab] = useState<TabKey>("assigned");
  const [starredIssues, setStarredIssues] = useState<IssueSummary[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<IssueSummary[] | null>(null);
  const [newFilterName, setNewFilterName] = useState("");
  const [selected, setSelected] = useState<IssueSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Probed first so the "not configured" state reads precisely, distinct from an
  // upstream failure, and so the lists below aren't asked for at all until JIRA
  // is reachable.
  const viewerRes = useCachedResource(VIEWER_KEY, probeJira, PROBE_FRESHNESS);
  const configured = viewerRes.data?.configured === true;
  // The two searches go to JIRA; the filters, stars and links behind them are
  // the sidecar's own rows and refresh on the shorter default.
  const assignedRes = useCachedResource<IssueSummary[]>(
    configured ? ASSIGNED_KEY : null,
    jiraAssigned,
    PROVIDER_FRESHNESS,
  );
  const createdRes = useCachedResource<IssueSummary[]>(
    configured ? CREATED_KEY : null,
    jiraCreated,
    PROVIDER_FRESHNESS,
  );
  const filtersRes = useCachedResource<IssueFilter[]>(configured ? FILTERS_KEY : null, () =>
    issueFilters("jira"),
  );
  const starsRes = useCachedResource<IssueStar[]>(configured ? STARS_KEY : null, () =>
    issueStars("jira"),
  );
  const linksRes = useCachedResource<IssueLink[]>(configured ? LINKS_KEY : null, () =>
    issueLinks("jira"),
  );

  const assigned = assignedRes.data ?? NO_ISSUES;
  const created = createdRes.data ?? NO_ISSUES;
  const stars = starsRes.data ?? NO_STARS;
  const filters = filtersRes.data ?? NO_FILTERS;
  const links = useMemo(
    () =>
      new Map(
        (linksRes.data ?? []).map((l) => [issueKey(l.provider, l.sourceKey, l.externalId), l]),
      ),
    [linksRes.data],
  );

  const combined = combineResources([
    viewerRes,
    assignedRes,
    createdRes,
    filtersRes,
    starsRes,
    linksRes,
  ]);
  const { loading, refreshing } = combined;
  const notConfigured = viewerRes.data?.configured === false;
  const error = searchError ?? combined.error;

  const starredKeys = useMemo(
    () => new Set(stars.map((s) => issueKey(s.provider, s.sourceKey, s.externalId))),
    [stars],
  );

  useOmniChatContext("issues", () => {
    if (selected) {
      return {
        source: "issues",
        summary: `Viewing JIRA issue ${selected.displayId} "${selected.title}" in ${selected.sourceLabel}`,
        details: { url: selected.url },
      };
    }
    const count =
      activeTab === "assigned"
        ? assigned.length
        : activeTab === "created"
          ? created.length
          : activeTab === "starred"
            ? starredIssues.length
            : (searchResults?.length ?? 0);
    return {
      source: "issues",
      summary: `On the Issues tab (JIRA ${activeTab} list, ${count} shown)`,
    };
  }, [selected, activeTab, assigned.length, created.length, starredIssues.length, searchResults]);

  const loadLinks = linksRes.refresh;

  /** Drops every JIRA resource at once; each mounted hook reloads itself. */
  const dropCaches = useCallback(() => {
    invalidatePrefix(JIRA_ISSUES_PREFIX);
  }, []);

  // Resolve starred issues to full rows (status/labels/assignee) via one JQL.
  useEffect(() => {
    if (activeTab !== "starred") return;
    const keys = stars.map((s) => s.externalId).filter((k) => ISSUE_KEY_RE.test(k));
    if (keys.length === 0) {
      setStarredIssues([]);
      return;
    }
    let live = true;
    setSearchError(null);
    jiraSearch(`issuekey in (${keys.join(",")}) ORDER BY updated DESC`)
      .then((rows) => live && setStarredIssues(rows))
      .catch((e) => live && setSearchError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [activeTab, stars]);

  const onToggleStar = useCallback(
    async (issue: IssueSummary, starred: boolean) => {
      if (starred) await removeIssueStar(issue);
      else await addIssueStar(issue);
      await starsRes.refresh();
    },
    [starsRes.refresh],
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

  const startFlow = useJiraStartWork(loadLinks);
  // A row counts as busy from the click until the picker closes: first while
  // its detail loads, then while the dialog shows that ticket's transitions.
  const isStarting = useCallback(
    (issue: IssueSummary) =>
      startFlow.preparingKey === issue.externalId ||
      startFlow.pending?.externalId === issue.externalId,
    [startFlow.preparingKey, startFlow.pending],
  );
  const onStartWork = useCallback(
    (issue: IssueSummary) => void startFlow.start(issue.externalId),
    [startFlow.start],
  );
  // Opening a ticket abandons a start begun on another row — otherwise its
  // detail lands unseen and the picker springs open on the way back.
  const onOpen = useCallback(
    (issue: IssueSummary) => {
      startFlow.cancel();
      setSelected(issue);
    },
    [startFlow.cancel],
  );

  const runSearch = useCallback(async (jql: string) => {
    // Cleared up front, or a search that failed once keeps its banner for the
    // life of the view — and hides every list error behind it, since it takes
    // precedence over them.
    setSearchError(null);
    setSearchResults(await jiraSearch(jql));
  }, []);

  const onSubmitSearch = useCallback(() => {
    const text = searchText.trim();
    if (!text) return;
    setSearchError(null);
    // A bare issue key opens that issue directly; anything else is JQL. JIRA
    // keys are upper-case, so normalise once and derive every field from it so
    // the composite issueKey() matches stored stars/links.
    if (ISSUE_KEY_RE.test(text)) {
      const key = text.toUpperCase();
      const projectKey = key.replace(/-\d+$/, "");
      setSelected({
        provider: "jira",
        sourceKey: projectKey,
        sourceLabel: projectKey,
        externalId: key,
        displayId: key,
        title: key,
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
    void runSearch(text).catch((e) => setSearchError(e instanceof Error ? e.message : String(e)));
  }, [searchText, runSearch]);

  const saveFilter = useCallback(async () => {
    if (!newFilterName.trim() || !searchText.trim()) return;
    await createIssueFilter(newFilterName.trim(), searchText.trim(), "jira");
    setNewFilterName("");
    await filtersRes.refresh();
  }, [newFilterName, searchText, filtersRes.refresh]);

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

  const listProps = {
    providerName: "JIRA",
    isStarred,
    linkFor,
    isStarting,
    onToggleStar,
    onOpen,
    onStartWork,
  };

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
          <div className="flex items-center gap-2">
            <RefreshingIndicator active={refreshing} />
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-800"
            >
              + New issue
            </button>
          </div>
        </div>

        {loading && <LoadingIndicator className="text-sm text-zinc-600" />}

        {activeTab === "assigned" && !loading && (
          <StatusGroupedIssueList
            issues={assigned}
            emptyText="No open issues assigned to you."
            {...listProps}
          />
        )}
        {activeTab === "created" && !loading && (
          <StatusGroupedIssueList
            issues={created}
            emptyText="No open issues reported by you."
            {...listProps}
          />
        )}
        {activeTab === "starred" && !loading && (
          <StatusGroupedIssueList
            issues={starredIssues}
            emptyText="No starred issues."
            {...listProps}
          />
        )}

        {activeTab === "search" && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                value={searchText}
                aria-label="JQL query or issue key"
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
                        void runSearch(f.query).catch((e) =>
                          setSearchError(e instanceof Error ? e.message : String(e)),
                        );
                      }}
                      className="hover:text-zinc-100"
                    >
                      {f.name}
                    </button>
                    <DeleteFilterButton
                      onDelete={async () => {
                        await deleteIssueFilter(f.id, "jira");
                        await filtersRes.refresh();
                      }}
                    />
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
                    aria-label="Name for the saved filter"
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
                <StatusGroupedIssueList
                  issues={searchResults}
                  emptyText="No matches."
                  {...listProps}
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {/* Separate from the list error, and only while no picker is open: the
            dialog renders its own start failures on top of this view. */}
        {!startFlow.pending && startFlow.error && (
          <p className="text-sm text-red-400">{startFlow.error}</p>
        )}
      </div>

      {startFlow.pending && (
        <JiraRepoPickerModal
          projectKey={startFlow.pending.sourceKey}
          issueKey={startFlow.pending.displayId}
          transitions={startFlow.pending.transitions}
          busy={startFlow.starting}
          startError={startFlow.error}
          onConfirm={(choice) => void startFlow.confirm(choice)}
          onClose={startFlow.cancel}
        />
      )}

      {creating && (
        <JiraCreateIssueModal onClose={() => setCreating(false)} onCreated={dropCaches} />
      )}
    </div>
  );
}
