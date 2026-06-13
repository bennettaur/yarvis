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
import { usePrStatus } from "../lib/pr/cache";
import {
  ghCreateFilter,
  ghDeleteFilter,
  ghFilters,
  ghSearch,
  ghStars,
  ghViewer,
} from "../lib/pr/github";
import { refDisplayRepo, refKey, refNumber } from "../lib/pr/ref";
import type { AzFilter, GhFilter, Provider, PrStatus, PrSummary } from "../lib/pr/types";
import { formatRelativeTime } from "../lib/time";
import { openExternal } from "../lib/url";
import PrDetailView from "./PrDetailView";

const GH_MY = "is:open is:pr author:@me";
const GH_REVIEW = "is:open is:pr review-requested:@me";

type TabKey = "mine" | "review" | "filters";

const TABS: { key: TabKey; label: string }[] = [
  { key: "mine", label: "My PRs" },
  { key: "review", label: "Needs review" },
  { key: "filters", label: "Filters" },
];

const PROVIDERS: { key: Provider; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "azure", label: "Azure DevOps" },
];

function createdMs(pr: PrSummary): number {
  return new Date(pr.createdAt).getTime() || 0;
}

/** Groups PRs by their display repo, newest-first within each group and across groups. */
function groupByRepo(prs: PrSummary[]): { repo: string; prs: PrSummary[] }[] {
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

function PrRow({
  pr,
  starred,
  onToggleStar,
  onReview,
}: {
  pr: PrSummary;
  starred: boolean;
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

/** Renders PRs grouped under repo headers, newest-first. */
function PrGroupedList({
  prs,
  isStarred,
  onToggleStar,
  onReview,
}: {
  prs: PrSummary[];
  isStarred: (pr: PrSummary) => boolean;
  onToggleStar: (pr: PrSummary, starred: boolean) => void;
  onReview: (pr: PrSummary) => void;
}) {
  const groups = useMemo(() => groupByRepo(prs), [prs]);
  if (prs.length === 0) return <p className="text-sm text-zinc-600">None.</p>;
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.repo}>
          <h3 className="mb-2 text-sm font-medium text-zinc-300">
            {group.repo}
            <span className="ml-2 text-xs text-zinc-600">({group.prs.length})</span>
          </h3>
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {group.prs.map((pr) => (
              <PrRow
                key={pr.url}
                pr={pr}
                starred={isStarred(pr)}
                onToggleStar={onToggleStar}
                onReview={onReview}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default function PrsPanel() {
  const [provider, setProvider] = useState<Provider>("github");
  const [tokenMissing, setTokenMissing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("mine");
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
  const [selected, setSelected] = useState<PrSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    const count = activeTab === "mine" ? mine.length : activeTab === "review" ? review.length : 0;
    return {
      source: "prs",
      summary: `On the PRs tab (${provider}, ${activeTab} list, ${count} shown)`,
    };
  }, [selected, activeTab, provider, mine.length, review.length]);

  const loadStars = useCallback(async (p: Provider) => {
    const stars = p === "github" ? await ghStars() : await azStars();
    setStarredKeys(new Set(stars.map((s) => refKey(s.ref))));
  }, []);

  useEffect(() => {
    setTokenMissing(false);
    setError(null);
    setSelected(null);
    setFilterResults(null);
    setMine([]);
    setReview([]);
    setStarredKeys(new Set());
    void (async () => {
      try {
        if (provider === "github") await ghViewer();
        else await azViewer();
      } catch {
        setTokenMissing(true);
        return;
      }
      try {
        if (provider === "github") {
          setMine(await ghSearch(GH_MY));
          setReview(await ghSearch(GH_REVIEW));
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
  }, [provider, loadStars]);

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

  const providerToggle = (
    <div className="inline-flex rounded-lg border border-zinc-700 p-0.5">
      {PROVIDERS.map((p) => (
        <button
          key={p.key}
          onClick={() => setProvider(p.key)}
          className={`rounded-md px-3 py-1 text-sm ${
            provider === p.key ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );

  if (tokenMissing) {
    return (
      <div className="space-y-4">
        {providerToggle}
        {provider === "github" ? (
          <p className="text-sm text-zinc-400">
            No GitHub token configured. Add one under <b>Dashboard → Secrets → GitHub token</b> to
            see your PRs.
          </p>
        ) : (
          <p className="text-sm text-zinc-400">
            No Azure DevOps token or org URL configured. Add them under{" "}
            <b>Dashboard → Secrets → Azure DevOps token</b> to see your PRs.
          </p>
        )}
      </div>
    );
  }

  if (selected) {
    return <PrDetailView pr={selected} onBack={() => setSelected(null)} />;
  }

  const listProps = { isStarred, onToggleStar, onReview: setSelected };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">{providerToggle}</div>

      <nav className="flex gap-1 border-b border-zinc-800">
        {TABS.map((tab) => {
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

      {activeTab === "filters" && provider === "github" && (
        <div className="space-y-5">
          <section>
            <div className="mb-3 flex flex-wrap gap-2">
              {ghFilterList.map((f) => (
                <span
                  key={f.id}
                  className="flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs"
                >
                  <button onClick={() => void runGhFilter(f.query)} className="hover:text-zinc-100">
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
  );
}
