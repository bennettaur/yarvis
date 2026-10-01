import { useCallback, useEffect, useMemo, useState } from "react";
import {
  boardsAssigned,
  boardsCreated,
  boardsItems,
  boardsSearch,
  boardsViewer,
} from "../../lib/azureBoards/api";
import { statesAsTransitions, useBoardsStartWork } from "../../lib/azureBoards/useBoardsStartWork";
import {
  addIssueStar,
  createIssueFilter,
  deleteIssueFilter,
  issueFilters,
  issueLinks,
  issueStars,
  removeIssueStar,
} from "../../lib/issues/api";
import { AZURE_BOARDS_ISSUES_PREFIX } from "../../lib/issues/cacheKeys";
import {
  type IssueFilter,
  type IssueLink,
  type IssueStar,
  type IssueSummary,
  issueKey,
} from "../../lib/issues/types";
import { useOmniChatContext } from "../../lib/omniChatContext";
import {
  combineResources,
  PROBE_FRESHNESS,
  PROVIDER_FRESHNESS,
  useCachedResource,
} from "../../lib/resourceCache";
import DeleteFilterButton from "../DeleteFilterButton";
import LoadingIndicator from "../LoadingIndicator";
import RefreshingIndicator from "../RefreshingIndicator";
import AzureBoardsItemDetailView from "./AzureBoardsItemDetailView";
import JiraRepoPickerModal from "./JiraRepoPickerModal";
import StatusGroupedIssueList from "./StatusGroupedIssueList";

type TabKey = "assigned" | "created" | "search" | "starred";

const VIEWER_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}viewer`;
const ASSIGNED_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}assigned`;
const CREATED_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}created`;
const FILTERS_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}filters`;
const STARS_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}stars`;
const LINKS_KEY = `${AZURE_BOARDS_ISSUES_PREFIX}links`;

/** Stable identities so an unloaded resource doesn't re-render the lists. */
const NO_ISSUES: IssueSummary[] = [];
const NO_STARS: IssueStar[] = [];
const NO_FILTERS: IssueFilter[] = [];

/**
 * "Not configured" comes back as data so it is cached and a remount paints the
 * explanation straight away. Anything else is rethrown and not cached, because
 * "your settings are missing" and "Azure is down" send the user to different
 * places and must not read the same.
 */
async function probeBoards(): Promise<{ configured: boolean }> {
  try {
    await boardsViewer();
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

/** The sidecar's `/items` route takes at most this many ids. */
const MAX_STARRED = 200;

/** A bare work item id, optionally with a leading `#`. */
const WORK_ITEM_ID_RE = /^#?(\d{1,10})$/;

/** A placeholder summary for opening a work item by id; the detail view fills it in. */
function summaryForId(id: string): IssueSummary {
  return {
    provider: "azure",
    sourceKey: "",
    sourceLabel: "",
    externalId: id,
    displayId: `#${id}`,
    title: `#${id}`,
    url: "",
    state: "open",
    author: "",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
    commentCount: 0,
  };
}

/**
 * The Azure Boards view: work items assigned to or created by the user, a
 * search (WIQL, title text, or a work item id), and starred items, grouped by
 * project and state. Shown when the Issues panel's provider toggle is set to
 * Azure Boards.
 */
export default function AzureBoardsIssuesView({
  requested,
  onRequestConsumed,
}: {
  /** A work item another view (the attention panel) asked to open directly. */
  requested?: IssueSummary | null;
  onRequestConsumed?: () => void;
} = {}) {
  const [activeTab, setActiveTab] = useState<TabKey>("assigned");
  const [starredItems, setStarredItems] = useState<IssueSummary[]>([]);
  const [searchText, setSearchText] = useState("");
  const [searchResults, setSearchResults] = useState<IssueSummary[] | null>(null);
  const [newFilterName, setNewFilterName] = useState("");
  const [selected, setSelected] = useState<IssueSummary | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    if (!requested) return;
    setSelected(requested);
    onRequestConsumed?.();
  }, [requested, onRequestConsumed]);

  const viewerRes = useCachedResource(VIEWER_KEY, probeBoards, PROBE_FRESHNESS);
  const configured = viewerRes.data?.configured === true;
  const assignedRes = useCachedResource<IssueSummary[]>(
    configured ? ASSIGNED_KEY : null,
    boardsAssigned,
    PROVIDER_FRESHNESS,
  );
  const createdRes = useCachedResource<IssueSummary[]>(
    configured ? CREATED_KEY : null,
    boardsCreated,
    PROVIDER_FRESHNESS,
  );
  const filtersRes = useCachedResource<IssueFilter[]>(configured ? FILTERS_KEY : null, () =>
    issueFilters("azure"),
  );
  const starsRes = useCachedResource<IssueStar[]>(configured ? STARS_KEY : null, () =>
    issueStars("azure"),
  );
  const linksRes = useCachedResource<IssueLink[]>(configured ? LINKS_KEY : null, () =>
    issueLinks("azure"),
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
        summary: `Viewing Azure Boards work item ${selected.displayId} "${selected.title}"${
          selected.sourceLabel ? ` in ${selected.sourceLabel}` : ""
        }`,
        details: { url: selected.url },
      };
    }
    const count =
      activeTab === "assigned"
        ? assigned.length
        : activeTab === "created"
          ? created.length
          : activeTab === "starred"
            ? starredItems.length
            : (searchResults?.length ?? 0);
    return {
      source: "issues",
      summary: `On the Issues tab (Azure Boards ${activeTab} list, ${count} shown)`,
    };
  }, [selected, activeTab, assigned.length, created.length, starredItems.length, searchResults]);

  const loadLinks = linksRes.refresh;

  // Resolve starred work items to full rows in one batch call.
  useEffect(() => {
    if (activeTab !== "starred") return;
    const ids = stars
      .map((s) => s.externalId)
      .filter((id) => WORK_ITEM_ID_RE.test(id))
      .slice(0, MAX_STARRED);
    if (ids.length === 0) {
      setStarredItems([]);
      return;
    }
    let live = true;
    setSearchError(null);
    boardsItems(ids)
      .then((rows) => live && setStarredItems(rows))
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

  const startFlow = useBoardsStartWork(loadLinks);
  const isStarting = useCallback(
    (issue: IssueSummary) =>
      startFlow.preparingId === issue.externalId ||
      startFlow.pending?.externalId === issue.externalId,
    [startFlow.preparingId, startFlow.pending],
  );
  const onStartWork = useCallback(
    (issue: IssueSummary) => void startFlow.start(issue.externalId),
    [startFlow.start],
  );
  // Opening an item abandons a start begun on another row, so its picker
  // doesn't spring open on the way back.
  const onOpen = useCallback(
    (issue: IssueSummary) => {
      startFlow.cancel();
      setSelected(issue);
    },
    [startFlow.cancel],
  );

  const runSearch = useCallback(async (query: string) => {
    setSearchError(null);
    setSearchResults(await boardsSearch(query));
  }, []);

  const onSubmitSearch = useCallback(() => {
    const text = searchText.trim();
    if (!text) return;
    setSearchError(null);
    const idMatch = WORK_ITEM_ID_RE.exec(text);
    if (idMatch?.[1]) {
      setSelected(summaryForId(idMatch[1]));
      return;
    }
    void runSearch(text).catch((e) => setSearchError(e instanceof Error ? e.message : String(e)));
  }, [searchText, runSearch]);

  const saveFilter = useCallback(async () => {
    if (!newFilterName.trim() || !searchText.trim()) return;
    await createIssueFilter(newFilterName.trim(), searchText.trim(), "azure");
    setNewFilterName("");
    await filtersRes.refresh();
  }, [newFilterName, searchText, filtersRes.refresh]);

  if (selected) {
    return (
      <AzureBoardsItemDetailView
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
          Azure Boards isn’t configured. It uses the same Azure DevOps organization URL and personal
          access token as the PR dashboard: add them in Settings → Credentials. The token needs the
          Work Items (Read &amp; write) scope.
        </p>
      </div>
    );
  }

  const listProps = {
    providerName: "Azure Boards",
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
          <RefreshingIndicator active={refreshing} />
        </div>

        {loading && <LoadingIndicator className="text-sm text-zinc-600" />}

        {activeTab === "assigned" && !loading && (
          <StatusGroupedIssueList
            issues={assigned}
            emptyText="No open work items assigned to you."
            {...listProps}
          />
        )}
        {activeTab === "created" && !loading && (
          <StatusGroupedIssueList
            issues={created}
            emptyText="No open work items created by you."
            {...listProps}
          />
        )}
        {activeTab === "starred" && !loading && (
          <StatusGroupedIssueList
            issues={starredItems}
            emptyText="No starred work items."
            {...listProps}
          />
        )}

        {activeTab === "search" && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input
                value={searchText}
                aria-label="WIQL query, title text or work item id"
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onSubmitSearch()}
                placeholder="Title text, a work item id like 1234, or WIQL starting with SELECT"
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
                        await deleteIssueFilter(f.id, "azure");
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
                    placeholder="Save this search as…"
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
        {!startFlow.pending && startFlow.error && (
          <p className="text-sm text-red-400">{startFlow.error}</p>
        )}
      </div>

      {startFlow.pending && (
        <JiraRepoPickerModal
          // The picker remembers the last repos per key; the prefix keeps an
          // Azure project from sharing a JIRA project key's choice.
          projectKey={`azure:${startFlow.pending.sourceKey}`}
          issueKey={startFlow.pending.displayId}
          transitions={statesAsTransitions(startFlow.pending)}
          busy={startFlow.starting}
          startError={startFlow.error}
          onConfirm={(choice) => void startFlow.confirm(choice)}
          onClose={startFlow.cancel}
        />
      )}
    </div>
  );
}
