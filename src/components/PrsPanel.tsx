import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type GhFilter,
  ghAddStar,
  ghCreateFilter,
  ghDeleteFilter,
  ghFilters,
  ghRemoveStar,
  ghSearch,
  ghStars,
  ghViewer,
  type PrStatus,
  type PrSummary,
} from "../lib/github";
import { usePrStatus } from "../lib/githubCache";
import { useOmniChatContext } from "../lib/omniChatContext";
import { formatRelativeTime } from "../lib/time";
import { openExternal } from "../lib/url";
import PrDetailView from "./PrDetailView";

const MY_PRS = "is:open is:pr author:@me";
const REVIEW = "is:open is:pr review-requested:@me";

type TabKey = "mine" | "review" | "filters";

const TABS: { key: TabKey; label: string }[] = [
  { key: "mine", label: "My PRs" },
  { key: "review", label: "Needs review" },
  { key: "filters", label: "Filters" },
];

function starKey(owner: string, repo: string, number: number) {
  return `${owner}/${repo}/${number}`;
}

function createdMs(pr: PrSummary): number {
  return new Date(pr.createdAt).getTime() || 0;
}

/** Groups PRs by owner/repo, newest-first within each group and across groups. */
function groupByRepo(prs: PrSummary[]): { repo: string; prs: PrSummary[] }[] {
  const map = new Map<string, PrSummary[]>();
  for (const pr of prs) {
    const key = `${pr.owner}/${pr.repo}`;
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
  const { data: status } = usePrStatus(pr.owner, pr.repo, pr.number);

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
          #{pr.number} · {pr.author} · opened {formatRelativeTime(pr.createdAt)}
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
        title="Open on GitHub"
      >
        ↗
      </button>
    </li>
  );
}

/** Renders PRs grouped under owner/repo headers, newest-first. */
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
  const [tokenMissing, setTokenMissing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("mine");
  const [mine, setMine] = useState<PrSummary[]>([]);
  const [review, setReview] = useState<PrSummary[]>([]);
  const [starredKeys, setStarredKeys] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<GhFilter[]>([]);
  const [filterResults, setFilterResults] = useState<PrSummary[] | null>(null);
  const [newFilter, setNewFilter] = useState({ name: "", query: "" });
  const [selected, setSelected] = useState<PrSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tell Omni Chat which PR the user is looking at (or which list), so it can
  // act on "this PR" without the user spelling out the details.
  useOmniChatContext("prs", () => {
    if (selected) {
      return {
        source: "prs",
        summary: `Reviewing PR #${selected.number} "${selected.title}" in ${selected.owner}/${selected.repo}`,
        details: {
          url: selected.url,
          author: selected.author,
          draft: selected.draft,
        },
      };
    }
    const count = activeTab === "mine" ? mine.length : activeTab === "review" ? review.length : 0;
    return {
      source: "prs",
      summary: `On the PRs tab (${activeTab} list, ${count} shown)`,
    };
  }, [selected, activeTab, mine.length, review.length]);

  const loadStars = useCallback(async () => {
    const stars = await ghStars();
    setStarredKeys(new Set(stars.map((s) => starKey(s.owner, s.repo, s.number))));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await ghViewer();
      } catch {
        setTokenMissing(true);
        return;
      }
      try {
        setMine(await ghSearch(MY_PRS));
        setReview(await ghSearch(REVIEW));
        setFilters(await ghFilters());
        await loadStars();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [loadStars]);

  const onToggleStar = useCallback(
    async (pr: PrSummary, starred: boolean) => {
      if (starred) {
        await ghRemoveStar(pr.owner, pr.repo, pr.number);
      } else {
        await ghAddStar({
          owner: pr.owner,
          repo: pr.repo,
          number: pr.number,
          title: pr.title,
          url: pr.url,
        });
      }
      await loadStars();
    },
    [loadStars],
  );

  const isStarred = useCallback(
    (pr: PrSummary) => starredKeys.has(starKey(pr.owner, pr.repo, pr.number)),
    [starredKeys],
  );

  const runFilter = useCallback(async (query: string) => {
    setFilterResults(await ghSearch(query));
  }, []);

  const addFilter = useCallback(async () => {
    if (!newFilter.name.trim() || !newFilter.query.trim()) return;
    await ghCreateFilter(newFilter.name.trim(), newFilter.query.trim());
    setNewFilter({ name: "", query: "" });
    setFilters(await ghFilters());
  }, [newFilter]);

  if (tokenMissing) {
    return (
      <p className="text-sm text-zinc-400">
        No GitHub token configured. Add one under <b>Dashboard → Secrets → GitHub token</b> to see
        your PRs.
      </p>
    );
  }

  if (selected) {
    return <PrDetailView pr={selected} onBack={() => setSelected(null)} />;
  }

  const listProps = { isStarred, onToggleStar, onReview: setSelected };

  return (
    <div className="space-y-5">
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
                      await ghDeleteFilter(f.id);
                      setFilters(await ghFilters());
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
                placeholder="is:open is:pr ..."
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

          {filterResults && <PrGroupedList prs={filterResults} {...listProps} />}
        </div>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
