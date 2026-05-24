import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import {
  ghAddStar,
  ghCreateFilter,
  ghDeleteFilter,
  ghFilters,
  ghPrStatus,
  ghRemoveStar,
  ghSearch,
  ghStars,
  ghViewer,
  type GhFilter,
  type PrStatus,
  type PrSummary,
} from "../lib/github";
import PrDetailView from "./PrDetailView";

const MY_PRS = "is:open is:pr author:@me";
const REVIEW = "is:open is:pr review-requested:@me";

function starKey(owner: string, repo: string, number: number) {
  return `${owner}/${repo}/${number}`;
}

function StatusBadge({ status }: { status: PrStatus | null }) {
  let text = "…";
  let color = "bg-zinc-700 text-zinc-300";
  if (status) {
    if (status.checks.failure > 0) {
      text = "CI failing";
      color = "bg-red-900 text-red-200";
    } else if (status.checks.pending > 0) {
      text = "CI running";
      color = "bg-amber-900 text-amber-200";
    } else if (status.mergeable === false) {
      text = "conflicts";
      color = "bg-red-900 text-red-200";
    } else {
      text = "ready";
      color = "bg-emerald-900 text-emerald-200";
    }
  }
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
  const [status, setStatus] = useState<PrStatus | null>(null);

  useEffect(() => {
    let active = true;
    if (pr.owner && pr.repo) {
      ghPrStatus(pr.owner, pr.repo, pr.number)
        .then((s) => active && setStatus(s))
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [pr.owner, pr.repo, pr.number]);

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={() => onToggleStar(pr, starred)}
        className={starred ? "text-amber-400" : "text-zinc-600 hover:text-zinc-400"}
        title={starred ? "Unstar" : "Star"}
      >
        ★
      </button>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => void openUrl(pr.url).catch(() => window.open(pr.url))}
          className="block truncate text-left text-sm text-zinc-100 hover:underline"
        >
          {pr.draft ? "[draft] " : ""}
          {pr.title}
        </button>
        <div className="text-xs text-zinc-500">
          {pr.owner}/{pr.repo}#{pr.number} · {pr.author}
        </div>
      </div>
      <button
        onClick={() => onReview(pr)}
        className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        Review
      </button>
      <StatusBadge status={status} />
    </li>
  );
}

function PrList({
  title,
  prs,
  isStarred,
  onToggleStar,
  onReview,
}: {
  title: string;
  prs: PrSummary[];
  isStarred: (pr: PrSummary) => boolean;
  onToggleStar: (pr: PrSummary, starred: boolean) => void;
  onReview: (pr: PrSummary) => void;
}) {
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        {title} ({prs.length})
      </h2>
      {prs.length === 0 ? (
        <p className="text-sm text-zinc-600">None.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
          {prs.map((pr) => (
            <PrRow
              key={pr.url}
              pr={pr}
              starred={isStarred(pr)}
              onToggleStar={onToggleStar}
              onReview={onReview}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default function PrsPanel() {
  const [tokenMissing, setTokenMissing] = useState(false);
  const [mine, setMine] = useState<PrSummary[]>([]);
  const [review, setReview] = useState<PrSummary[]>([]);
  const [starredKeys, setStarredKeys] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<GhFilter[]>([]);
  const [filterResults, setFilterResults] = useState<PrSummary[] | null>(null);
  const [newFilter, setNewFilter] = useState({ name: "", query: "" });
  const [selected, setSelected] = useState<PrSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        No GitHub token configured. Add one under <b>Dashboard → Secrets →
        GitHub token</b> to see your PRs.
      </p>
    );
  }

  if (selected) {
    return <PrDetailView pr={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-6">
      <PrList
        title="My PRs"
        prs={mine}
        isStarred={isStarred}
        onToggleStar={onToggleStar}
        onReview={setSelected}
      />
      <PrList
        title="Needs my review"
        prs={review}
        isStarred={isStarred}
        onToggleStar={onToggleStar}
        onReview={setSelected}
      />

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Saved filters
        </h2>
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

      {filterResults && (
        <PrList
          title="Filter results"
          prs={filterResults}
          isStarred={isStarred}
          onToggleStar={onToggleStar}
          onReview={setSelected}
        />
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
