import { useCallback, useEffect, useMemo, useState } from "react";
import { useOmniChatContext } from "../lib/omniChatContext";
import { addStar, removeStar } from "../lib/pr/api";
import {
  azCreateFilter,
  azDeleteFilter,
  azFilters,
  azSearch,
  azStars,
  azViewer,
} from "../lib/pr/azure";
import { PRS_PROBE_PREFIX, prsListPrefix } from "../lib/pr/cacheKeys";
import {
  ghCreateFilter,
  ghDeleteFilter,
  ghFilters,
  ghPrConfig,
  ghReviewing,
  ghSearch,
  ghStars,
  ghViewer,
} from "../lib/pr/github";
import { defaultPrsPlace, type PrsTabKey, readPrsPlace, writePrsPlace } from "../lib/pr/panelState";
import { refDisplayRepo, refKey, refNumber } from "../lib/pr/ref";
import type { AzFilter, GhFilter, Provider, PrSummary, ReviewingList } from "../lib/pr/types";
import {
  combineResources,
  PROBE_TTL_MS,
  PROVIDER_TTL_MS,
  useCachedResource,
} from "../lib/resourceCache";
import PrDetailView from "./PrDetailView";
import PrGroupedList from "./pr/PrGroupedList";
import PrLocator from "./pr/PrLocator";
import PrReviewingList from "./pr/PrReviewingList";
import RefreshingIndicator from "./RefreshingIndicator";

const GH_MY = "is:open is:pr author:@me";

/**
 * Whether one provider's credentials work. A 4xx is a definite "these don't",
 * worth caching for as long as the credentials themselves last. Anything else —
 * a sidecar still starting up, a network blip — is rethrown so it is not cached
 * at all: a transient failure must not take a provider off the toggle until the
 * probe's long TTL expires.
 */
async function probe(viewer: () => Promise<unknown>): Promise<boolean> {
  try {
    await viewer();
    return true;
  } catch (e) {
    const status = e && typeof e === "object" ? (e as { status?: unknown }).status : undefined;
    if (typeof status === "number" && status >= 400 && status < 500) return false;
    throw e;
  }
}

const probeGithub = () => probe(ghViewer);
const probeAzure = () => probe(azViewer);

/** The lists this panel shows for one provider, loaded together. */
interface ProviderLists {
  mine: PrSummary[];
  review: PrSummary[];
  ghFilters: GhFilter[];
  azFilters: AzFilter[];
}

const NO_LISTS: ProviderLists = { mine: [], review: [], ghFilters: [], azFilters: [] };

async function loadProviderLists(provider: Provider): Promise<ProviderLists> {
  if (provider === "github") {
    // The needs-review query is user-configurable (Settings → PR review), since
    // what counts as needing your attention varies by team.
    const config = await ghPrConfig();
    return {
      ...NO_LISTS,
      mine: await ghSearch(GH_MY),
      review: await ghSearch(config.reviewQuery),
      ghFilters: await ghFilters(),
    };
  }
  return {
    ...NO_LISTS,
    mine: await azSearch("mine"),
    review: await azSearch("review"),
    azFilters: await azFilters(),
  };
}

/**
 * The "Reviewing" tab is GitHub-only: it needs both the user's GitHub
 * comment/review history and a per-PR view of their own reviews, neither of
 * which the Azure DevOps integration exposes.
 */
function tabsFor(provider: Provider): { key: PrsTabKey; label: string }[] {
  return [
    { key: "mine", label: "My PRs" },
    { key: "review", label: "Needs review" },
    ...(provider === "github" ? [{ key: "reviewing" as PrsTabKey, label: "Reviewing" }] : []),
    { key: "filters", label: "Filters" },
  ];
}

const PROVIDERS: { key: Provider; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "azure", label: "Azure DevOps" },
];

export default function PrsPanel({
  requestedPr = null,
  onRequestConsumed,
  persistPlace = false,
}: {
  /** A PR another tab has asked us to open — auto-selected on mount/change. */
  requestedPr?: PrSummary | null;
  /** Called once we've consumed `requestedPr` so the parent can clear it. */
  onRequestConsumed?: () => void;
  /**
   * Restore and remember which provider/list/PR the user was on. Opt-in, and
   * only the PRs tab opts in: the place lives under one storage key, so a
   * second mount (the Omni "Pull Requests" widget) would fight the tab over it.
   */
  persistPlace?: boolean;
} = {}) {
  // Read once on mount; every later change flows back out through the effect
  // that writes the place below.
  const [restoredPlace] = useState(() => (persistPlace ? readPrsPlace() : defaultPrsPlace()));
  const [provider, setProvider] = useState<Provider>(restoredPlace.provider);
  const [activeTab, setActiveTab] = useState<PrsTabKey>(restoredPlace.tab);
  const [filterResults, setFilterResults] = useState<PrSummary[] | null>(null);
  const [newGhFilter, setNewGhFilter] = useState({ name: "", query: "" });
  const [newAzFilter, setNewAzFilter] = useState<{
    name: string;
    scope: "mine" | "review";
    project: string;
  }>({ name: "", scope: "mine", project: "" });
  const [selected, setSelected] = useState<PrSummary | null>(restoredPlace.selected);

  /**
   * Which providers have working credentials. Each probe is its own resource, so
   * a provider appears in the toggle the moment its own viewer call lands rather
   * than the toggle flashing both and hiding the bad one once the slowest probe
   * loses. `probeComplete` distinguishes "still checking, none confirmed yet"
   * from "checked, found nothing", so the empty state can't flash on first
   * paint.
   *
   * A probe that finds no working credentials resolves to `false` rather than
   * rejecting: "this provider isn't configured" is an answer worth caching, and
   * errors are not cached. A user with only GitHub set up would otherwise
   * re-probe Azure on every remount and hold `probeComplete` — and with it the
   * lists — behind that round trip.
   */
  const ghProbe = useCachedResource(`${PRS_PROBE_PREFIX}github`, probeGithub, PROBE_TTL_MS);
  const azProbe = useCachedResource(`${PRS_PROBE_PREFIX}azure`, probeAzure, PROBE_TTL_MS);
  const availableProviders = useMemo(() => {
    const set = new Set<Provider>();
    if (ghProbe.data) set.add("github");
    if (azProbe.data) set.add("azure");
    return set;
  }, [ghProbe.data, azProbe.data]);
  const probeComplete = !ghProbe.loading && !azProbe.loading;

  // The probe already confirmed the viewer works, so the lists skip a second
  // round trip and search straight away. Credentials invalidated mid-session
  // surface as this resource's error instead.
  const listsReady = probeComplete && availableProviders.has(provider);
  const listsRes = useCachedResource(
    listsReady ? `${prsListPrefix(provider)}lists` : null,
    () => loadProviderLists(provider),
    PROVIDER_TTL_MS,
  );
  const {
    mine,
    review,
    ghFilters: ghFilterList,
    azFilters: azFilterList,
  } = listsRes.data ?? NO_LISTS;

  const starsRes = useCachedResource(listsReady ? `${prsListPrefix(provider)}stars` : null, () =>
    provider === "github" ? ghStars() : azStars(),
  );
  const starredKeys = useMemo(
    () => new Set((starsRes.data ?? []).map((s) => refKey(s.ref))),
    [starsRes.data],
  );

  // The Reviewing list costs several GitHub round-trips (two searches plus a
  // batched lookup for PRs only the local event log knows about), so it stays
  // unkeyed until the tab is opened rather than loading beside the cheap ones.
  const reviewingRes = useCachedResource<ReviewingList>(
    activeTab === "reviewing" && provider === "github" && listsReady
      ? `${prsListPrefix("github")}reviewing`
      : null,
    ghReviewing,
    PROVIDER_TTL_MS,
  );
  const reviewing = reviewingRes.data;

  // A probe error is left out of `error` on purpose: it says one provider is
  // unreachable, which the toggle already shows by leaving it out, and the user
  // asked to see the provider they are on rather than a report on the other.
  const { refreshing } = combineResources([ghProbe, azProbe, listsRes, starsRes, reviewingRes]);
  const { error } = combineResources([listsRes, starsRes, reviewingRes]);

  const tabs = useMemo(() => tabsFor(provider), [provider]);

  // Tell Omni Chat which PR the user is looking at (or which list), so it can
  // act on "this PR" without the user spelling out the details.
  useOmniChatContext("prs", () => {
    if (selected) {
      return {
        source: "prs",
        summary: `Reviewing PR #${refNumber(selected.ref)} "${selected.title}" in ${refDisplayRepo(selected.ref)}`,
        details: { url: selected.url, author: selected.author, draft: selected.draft },
      };
    }
    const count =
      activeTab === "mine"
        ? mine.length
        : activeTab === "review"
          ? review.length
          : activeTab === "reviewing"
            ? (reviewing?.inProgress.length ?? 0)
            : 0;
    return {
      source: "prs",
      summary: `On the PRs tab (${provider}, ${activeTab} list, ${count} shown)`,
    };
  }, [selected, activeTab, provider, mine.length, review.length, reviewing]);

  // Honor a cross-tab open request: switch the toggle to the PR's provider and
  // jump straight to the detail view. Cleared via the consumed callback so a
  // second navigation back to PRs doesn't re-select an old request.
  useEffect(() => {
    if (!requestedPr) return;
    setProvider(requestedPr.ref.provider);
    setSelected(requestedPr);
    onRequestConsumed?.();
  }, [requestedPr, onRequestConsumed]);

  /**
   * User-initiated provider switch. Resets the selection and filter results
   * because they belong to the old provider. Provider state changes from other
   * sources (probe auto-correct, cross-tab open) deliberately do NOT reset
   * `selected`, so e.g. `requestedPr` lands on the detail view even when the
   * background list-fetch effect re-runs after the availability probe resolves.
   */
  const selectProvider = useCallback((p: Provider) => {
    setProvider(p);
    setSelected(null);
    setFilterResults(null);
  }, []);

  // Once probing is done, if the user is sitting on a provider that turned out
  // not to be configured, jump them to one that is. Done in a separate effect
  // (not the probe handlers) so it sees the fully-settled set rather than
  // racing the second probe.
  useEffect(() => {
    if (!probeComplete) return;
    if (availableProviders.has(provider)) return;
    const configured = availableProviders.has("github")
      ? "github"
      : availableProviders.has("azure")
        ? "azure"
        : null;
    if (!configured) return;
    setProvider(configured);
    // Unlike the provider change itself, a selection the new provider's client
    // can't fetch has to go: a restored PR whose credentials were revoked would
    // otherwise sit on a detail view that only ever errors. A cross-tab open
    // request is unaffected — it sets the provider to the PR's own.
    setSelected((prev) => (prev && prev.ref.provider !== configured ? null : prev));
  }, [probeComplete, availableProviders, provider]);

  // A provider switch can retire the active tab (Azure has no Reviewing list).
  useEffect(() => {
    if (!tabs.some((t) => t.key === activeTab)) setActiveTab("mine");
  }, [tabs, activeTab]);

  // Remember where the user is, so leaving the PRs tab and coming back — which
  // unmounts and remounts this panel — puts them back on the same list, or the
  // same PR, instead of resetting to GitHub / "My PRs".
  useEffect(() => {
    if (!persistPlace) return;
    writePrsPlace({ provider, tab: activeTab, selected });
  }, [persistPlace, provider, activeTab, selected]);

  const onToggleStar = useCallback(
    async (pr: PrSummary, starred: boolean) => {
      if (starred) await removeStar(pr.ref);
      else await addStar(pr.ref, pr.title, pr.url);
      await starsRes.refresh();
    },
    [starsRes.refresh],
  );

  const isStarred = useCallback((pr: PrSummary) => starredKeys.has(refKey(pr.ref)), [starredKeys]);

  const runGhFilter = useCallback(async (query: string) => {
    setFilterResults(await ghSearch(query));
  }, []);

  const runAzFilter = useCallback(async (scope: "mine" | "review", project: string | null) => {
    setFilterResults(await azSearch(scope, project ?? undefined));
  }, []);

  const addGhFilter = useCallback(async () => {
    if (!newGhFilter.name.trim() || !newGhFilter.query.trim()) return;
    await ghCreateFilter(newGhFilter.name.trim(), newGhFilter.query.trim());
    setNewGhFilter({ name: "", query: "" });
    await listsRes.refresh();
  }, [newGhFilter, listsRes.refresh]);

  const addAzFilter = useCallback(async () => {
    if (!newAzFilter.name.trim()) return;
    await azCreateFilter(
      newAzFilter.name.trim(),
      newAzFilter.scope,
      newAzFilter.project.trim() || null,
    );
    setNewAzFilter({ name: "", scope: "mine", project: "" });
    await listsRes.refresh();
  }, [newAzFilter, listsRes.refresh]);

  const visibleProviders = useMemo(
    () => PROVIDERS.filter((p) => availableProviders.has(p.key)),
    [availableProviders],
  );

  // With only one configured provider the toggle is just noise — hide it.
  const providerToggle =
    visibleProviders.length > 1 ? (
      <div className="inline-flex rounded-lg border border-zinc-700 p-0.5">
        {visibleProviders.map((p) => (
          <button
            key={p.key}
            onClick={() => selectProvider(p.key)}
            className={`rounded-md px-3 py-1 text-sm ${
              provider === p.key ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
    ) : null;

  if (probeComplete && availableProviders.size === 0) {
    // A probe that rejected rather than answering `false` means the provider
    // could not be reached at all, which is a different thing to fix — so say so
    // instead of sending the user to add a token they may already have.
    const unreachable = ghProbe.error ?? azProbe.error;
    return (
      <div className="h-full overflow-y-auto p-6">
        <p className="text-sm text-zinc-400">
          No PR provider configured. Add a GitHub token or Azure DevOps PAT in Settings →
          Credentials to see your PRs here.
        </p>
        {unreachable && <p className="mt-2 text-sm text-red-400">{unreachable}</p>}
      </div>
    );
  }

  if (selected) {
    // Object identity is the test for "we restored this": every other route to
    // a selection hands us a summary from a freshly fetched list or request.
    return (
      <PrDetailView
        pr={selected}
        onBack={() => setSelected(null)}
        recordView={selected !== restoredPlace.selected}
      />
    );
  }

  const listProps = { isStarred, onToggleStar, onReview: setSelected };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-3">
          {providerToggle}
          <RefreshingIndicator active={refreshing} />
        </div>

        {availableProviders.has("github") && <PrLocator onOpen={setSelected} />}

        <nav className="flex gap-1 border-b border-zinc-800">
          {tabs.map((tab) => {
            const count =
              tab.key === "mine" ? mine.length : tab.key === "review" ? review.length : null;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  activeTab === tab.key
                    ? "border-sky-500 text-zinc-100"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tab.label}
                {count !== null && <span className="ml-1.5 text-xs text-zinc-600">{count}</span>}
              </button>
            );
          })}
        </nav>

        {activeTab === "mine" && <PrGroupedList prs={mine} {...listProps} />}
        {activeTab === "review" && <PrGroupedList prs={review} {...listProps} />}

        {activeTab === "reviewing" &&
          (reviewing ? (
            <PrReviewingList list={reviewing} listProps={listProps} />
          ) : (
            <p className="text-sm text-zinc-600">
              {reviewingRes.loading ? "Loading…" : "Nothing to show."}
            </p>
          ))}

        {activeTab === "filters" && provider === "github" && (
          <div className="space-y-5">
            <section>
              <div className="mb-3 flex flex-wrap gap-2">
                {ghFilterList.map((f) => (
                  <span
                    key={f.id}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs"
                  >
                    <button
                      onClick={() => void runGhFilter(f.query)}
                      className="hover:text-zinc-100"
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={async () => {
                        await ghDeleteFilter(f.id);
                        await listsRes.refresh();
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
                  value={newGhFilter.name}
                  placeholder="Filter name"
                  onChange={(e) => setNewGhFilter((p) => ({ ...p, name: e.target.value }))}
                  className="w-32 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <input
                  value={newGhFilter.query}
                  placeholder="is:open is:pr ..."
                  onChange={(e) => setNewGhFilter((p) => ({ ...p, query: e.target.value }))}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <button
                  onClick={() => void addGhFilter()}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
            </section>
            {filterResults && <PrGroupedList prs={filterResults} {...listProps} />}
          </div>
        )}

        {activeTab === "filters" && provider === "azure" && (
          <div className="space-y-5">
            <section>
              <div className="mb-3 flex flex-wrap gap-2">
                {azFilterList.map((f) => (
                  <span
                    key={f.id}
                    className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs"
                  >
                    <button
                      onClick={() => void runAzFilter(f.scope, f.project)}
                      className="hover:text-zinc-100"
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={async () => {
                        await azDeleteFilter(f.id);
                        await listsRes.refresh();
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
                  value={newAzFilter.name}
                  placeholder="Filter name"
                  onChange={(e) => setNewAzFilter((p) => ({ ...p, name: e.target.value }))}
                  className="w-32 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <select
                  value={newAzFilter.scope}
                  onChange={(e) =>
                    setNewAzFilter((p) => ({ ...p, scope: e.target.value as "mine" | "review" }))
                  }
                  className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                >
                  <option value="mine">Created by me</option>
                  <option value="review">Needs my review</option>
                </select>
                <input
                  value={newAzFilter.project}
                  placeholder="Project (optional)"
                  onChange={(e) => setNewAzFilter((p) => ({ ...p, project: e.target.value }))}
                  className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
                />
                <button
                  onClick={() => void addAzFilter()}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
            </section>
            {filterResults && <PrGroupedList prs={filterResults} {...listProps} />}
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
