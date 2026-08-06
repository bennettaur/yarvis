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
import { type PrsTabKey, readPrsPlace, writePrsPlace } from "../lib/pr/panelState";
import { refDisplayRepo, refKey, refNumber } from "../lib/pr/ref";
import type { AzFilter, GhFilter, Provider, PrSummary, ReviewingList } from "../lib/pr/types";
import PrDetailView from "./PrDetailView";
import PrGroupedList from "./pr/PrGroupedList";
import PrLocator from "./pr/PrLocator";
import PrReviewingList from "./pr/PrReviewingList";

const GH_MY = "is:open is:pr author:@me";

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
}: {
  /** A PR another tab has asked us to open — auto-selected on mount/change. */
  requestedPr?: PrSummary | null;
  /** Called once we've consumed `requestedPr` so the parent can clear it. */
  onRequestConsumed?: () => void;
} = {}) {
  // Read once on mount; every later change flows back out through the effect
  // that writes the place below.
  const [restoredPlace] = useState(readPrsPlace);
  const [provider, setProvider] = useState<Provider>(restoredPlace.provider);
  /**
   * Which providers have working credentials. Starts EMPTY (rather than null /
   * a both-providers placeholder) and grows as each viewer probe lands, so the
   * provider toggle never flashes options that turn out to be unconfigured.
   * `probeComplete` separately tracks whether we've heard back from every probe
   * — needed to distinguish "still checking, none confirmed yet" from "checked,
   * found nothing" so the empty-state message doesn't flash on first paint.
   */
  const [availableProviders, setAvailableProviders] = useState<Set<Provider>>(new Set());
  const [probeComplete, setProbeComplete] = useState(false);
  const [activeTab, setActiveTab] = useState<PrsTabKey>(restoredPlace.tab);
  const [mine, setMine] = useState<PrSummary[]>([]);
  const [review, setReview] = useState<PrSummary[]>([]);
  const [starredKeys, setStarredKeys] = useState<Set<string>>(new Set());
  const [ghFilterList, setGhFilterList] = useState<GhFilter[]>([]);
  const [azFilterList, setAzFilterList] = useState<AzFilter[]>([]);
  const [filterResults, setFilterResults] = useState<PrSummary[] | null>(null);
  const [newGhFilter, setNewGhFilter] = useState({ name: "", query: "" });
  const [newAzFilter, setNewAzFilter] = useState<{
    name: string;
    scope: "mine" | "review";
    project: string;
  }>({ name: "", scope: "mine", project: "" });
  const [selected, setSelected] = useState<PrSummary | null>(restoredPlace.selected);
  const [error, setError] = useState<string | null>(null);
  /** Null until the Reviewing tab has been opened at least once, or on failure. */
  const [reviewing, setReviewing] = useState<ReviewingList | null>(null);
  /** One fetch per provider selection: "settled" covers both success and failure. */
  const [reviewingLoad, setReviewingLoad] = useState<"idle" | "loading" | "settled">("idle");

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

  const loadStars = useCallback(async (p: Provider) => {
    const stars = p === "github" ? await ghStars() : await azStars();
    setStarredKeys(new Set(stars.map((s) => refKey(s.ref))));
  }, []);

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

  // Probe both providers independently and add each one to the visible set the
  // moment its viewer call succeeds — so the toggle reveals providers as we
  // discover them rather than flashing both and then hiding the bad one once
  // the slowest probe loses. `probeComplete` flips when both have settled so
  // the empty-state can render without an earlier "neither configured" flash.
  useEffect(() => {
    let live = true;
    let outstanding = 2;
    const settle = () => {
      outstanding -= 1;
      if (outstanding === 0 && live) setProbeComplete(true);
    };
    const add = (provider: Provider) => {
      if (!live) return;
      setAvailableProviders((prev) => {
        if (prev.has(provider)) return prev;
        const next = new Set(prev);
        next.add(provider);
        return next;
      });
    };
    ghViewer()
      .then(() => add("github"))
      .catch(() => {})
      .finally(settle);
    azViewer()
      .then(() => add("azure"))
      .catch(() => {})
      .finally(settle);
    return () => {
      live = false;
    };
  }, []);

  // Once probing is done, if the user is sitting on a provider that turned out
  // not to be configured, jump them to one that is. Done in a separate effect
  // (not the probe handlers) so it sees the fully-settled set rather than
  // racing the second probe.
  useEffect(() => {
    if (!probeComplete) return;
    if (availableProviders.has(provider)) return;
    if (availableProviders.has("github")) setProvider("github");
    else if (availableProviders.has("azure")) setProvider("azure");
  }, [probeComplete, availableProviders, provider]);

  // Refetch the per-provider lists whenever provider or availability changes.
  // Deliberately does NOT touch `selected`: that's owned by user actions
  // (clicking a row, the Back button) and the cross-tab open request, so this
  // effect re-running on availability arrival never clobbers an in-flight
  // navigation to a specific PR.
  useEffect(() => {
    setError(null);
    setMine([]);
    setReview([]);
    setReviewing(null);
    setReviewingLoad("idle");
    setStarredKeys(new Set());
    if (!probeComplete) return;
    if (!availableProviders.has(provider)) return;
    // The probe already confirmed the viewer works for this provider, so we
    // skip a second viewer round-trip and go straight to fetching the lists.
    // If credentials get invalidated mid-session, the search calls land in
    // the catch below.
    void (async () => {
      try {
        if (provider === "github") {
          setMine(await ghSearch(GH_MY));
          // The needs-review query is user-configurable (Settings → PR review),
          // since what counts as needing your attention varies by team.
          const config = await ghPrConfig();
          setReview(await ghSearch(config.reviewQuery));
          setGhFilterList(await ghFilters());
        } else {
          setMine(await azSearch("mine"));
          setReview(await azSearch("review"));
          setAzFilterList(await azFilters());
        }
        await loadStars(provider);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [provider, loadStars, availableProviders, probeComplete]);

  // The Reviewing list costs several GitHub round-trips (two searches plus a
  // batched lookup for PRs only the local event log knows about), so it loads
  // when the tab is first opened rather than alongside the cheap searches.
  // Keyed on `reviewingLoad` rather than on the list itself: a failed attempt
  // leaves no list, and re-running off that emptiness would retry forever.
  useEffect(() => {
    if (activeTab !== "reviewing" || provider !== "github") return;
    if (reviewingLoad !== "idle") return;
    let live = true;
    setReviewingLoad("loading");
    ghReviewing()
      .then((list) => {
        if (live) setReviewing(list);
      })
      .catch((e) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setReviewingLoad("settled");
      });
    return () => {
      live = false;
    };
  }, [activeTab, provider, reviewingLoad]);

  // A provider switch can retire the active tab (Azure has no Reviewing list).
  useEffect(() => {
    if (!tabs.some((t) => t.key === activeTab)) setActiveTab("mine");
  }, [tabs, activeTab]);

  // Remember where the user is, so leaving the PRs tab and coming back — which
  // unmounts and remounts this panel — puts them back on the same list, or the
  // same PR, instead of resetting to GitHub / "My PRs".
  useEffect(() => {
    writePrsPlace({ provider, tab: activeTab, selected });
  }, [provider, activeTab, selected]);

  const onToggleStar = useCallback(
    async (pr: PrSummary, starred: boolean) => {
      if (starred) await removeStar(pr.ref);
      else await addStar(pr.ref, pr.title, pr.url);
      await loadStars(provider);
    },
    [loadStars, provider],
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
    setGhFilterList(await ghFilters());
  }, [newGhFilter]);

  const addAzFilter = useCallback(async () => {
    if (!newAzFilter.name.trim()) return;
    await azCreateFilter(
      newAzFilter.name.trim(),
      newAzFilter.scope,
      newAzFilter.project.trim() || null,
    );
    setNewAzFilter({ name: "", scope: "mine", project: "" });
    setAzFilterList(await azFilters());
  }, [newAzFilter]);

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
    return (
      <div className="h-full overflow-y-auto p-6">
        <p className="text-sm text-zinc-400">
          No PR provider configured. Add a GitHub token or Azure DevOps PAT in Settings →
          Credentials to see your PRs here.
        </p>
      </div>
    );
  }

  if (selected) {
    return <PrDetailView pr={selected} onBack={() => setSelected(null)} />;
  }

  const listProps = { isStarred, onToggleStar, onReview: setSelected };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="space-y-5">
        <div className="flex items-center justify-between">{providerToggle}</div>

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
              {reviewingLoad === "settled" ? "Nothing to show." : "Loading…"}
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
                        setGhFilterList(await ghFilters());
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
                        setAzFilterList(await azFilters());
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
