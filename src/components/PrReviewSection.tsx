import { useEffect, useState } from "react";
import { ghPrConfig, ghSavePrConfig } from "../lib/pr/github";
import type { GhPrConfig } from "../lib/pr/types";
import { openExternal } from "../lib/url";

const SEARCH_DOCS =
  "https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests";

/** Ready-made queries for the common ways teams decide what needs a look. */
const PRESETS: { label: string; query: string; hint: string }[] = [
  {
    label: "Requested of me",
    query: "is:open is:pr review-requested:@me",
    hint: "Review requested from you directly or via one of your teams",
  },
  {
    label: "Requested of me, no drafts",
    query: "is:open is:pr review-requested:@me -is:draft",
    hint: "Same, minus PRs the author hasn't published yet",
  },
  {
    label: "Requested of me, not yet reviewed",
    query: "is:open is:pr review-requested:@me -reviewed-by:@me -is:draft",
    hint: "Drops PRs you've already left a review on",
  },
];

/**
 * Configures the GitHub PR dashboard: the search behind "Needs review", and how
 * far back the "Reviewing" list looks for PRs you've touched. Persisted to the
 * sidecar DB via /api/github/config.
 *
 * The query is GitHub's own search syntax rather than a set of checkboxes,
 * because what counts as "needs my review" differs per team — team-owned
 * requests, an org filter, drafts in or out — and the search grammar already
 * expresses all of it.
 */
export default function PrReviewSection() {
  const [config, setConfig] = useState<GhPrConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ghPrConfig()
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error && !config) {
    return <p className="text-sm text-red-400">Couldn't load config: {error}</p>;
  }
  if (!config) return <p className="text-sm text-zinc-500">Loading…</p>;

  const update = (patch: Partial<GhPrConfig>) => {
    setSaved(false);
    setConfig({ ...config, ...patch });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setConfig(
        await ghSavePrConfig({
          reviewQuery: config.reviewQuery.trim(),
          reviewingLookbackDays: config.reviewingLookbackDays,
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100">"Needs review" search</h3>
        <p className="text-xs text-zinc-500">
          A GitHub issue search, run as-is. See{" "}
          <button
            onClick={() => openExternal(SEARCH_DOCS)}
            className="text-sky-400 hover:underline"
          >
            GitHub's search syntax
          </button>
          .
        </p>
        <input
          value={config.reviewQuery}
          onChange={(e) => update({ reviewQuery: e.target.value })}
          spellCheck={false}
          className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 font-mono text-sm"
        />
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <button
              key={preset.query}
              onClick={() => update({ reviewQuery: preset.query })}
              title={preset.hint}
              className={`rounded-md border px-2 py-1 text-xs ${
                config.reviewQuery === preset.query
                  ? "border-sky-600 text-zinc-100"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-zinc-100">"Reviewing" history</h3>
        <p className="text-xs text-zinc-500">
          How far back to look for PRs you've opened in yarvis, commented on, or reviewed.
        </p>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="number"
            min={1}
            max={365}
            value={config.reviewingLookbackDays}
            onChange={(e) => update({ reviewingLookbackDays: Number(e.target.value) })}
            className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          />
          days
        </label>
      </section>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={saving || !config.reviewQuery.trim()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:text-zinc-600"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
