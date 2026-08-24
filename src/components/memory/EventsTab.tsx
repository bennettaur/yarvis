import { useCallback, useEffect, useState } from "react";
import { type EventRecord, listEvents, listEventTypes } from "../../lib/events";

/**
 * The raw activity log. Paginated and searchable because it is append-only and
 * grows every time the user does anything — the point of the tab is to check
 * what was recorded (and to fill a gap the summaries don't cover yet), not to
 * scroll the whole history.
 */

const PAGE_SIZE = 50;

/** Groups the type list by its leading domain, so the filter isn't 38 flat options. */
function domainOf(type: string): string {
  return type.split(".")[0] ?? type;
}

/** One line of payload, short enough to sit on a row. */
function summarize(payload: Record<string, unknown> | null): string {
  if (!payload) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) continue;
    const rendered = typeof value === "object" ? JSON.stringify(value) : String(value);
    parts.push(`${key}=${rendered}`);
    if (parts.join(" ").length > 160) break;
  }
  return parts.join(" ").slice(0, 200);
}

export default function EventsTab() {
  const [page, setPage] = useState<{ items: EventRecord[]; total: number }>({
    items: [],
    total: 0,
  });
  const [types, setTypes] = useState<string[]>([]);
  const [domain, setDomain] = useState<string>("");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listEventTypes()
      .then(setTypes)
      .catch(() => setTypes([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // A domain filter expands to every type under it, since the API filters by
      // exact type — which keeps the type list the single source of truth.
      const selected = domain ? types.filter((t) => domainOf(t) === domain) : undefined;
      setPage(
        await listEvents({ types: selected, q: applied || undefined, limit: PAGE_SIZE, offset }),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [domain, types, applied, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const domains = [...new Set(types.map(domainOf))].sort();
  const shownTo = Math.min(offset + PAGE_SIZE, page.total);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={domain}
          onChange={(e) => {
            setOffset(0);
            setDomain(e.target.value);
          }}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
        >
          <option value="">All activity</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <input
          value={query}
          placeholder="Search events…"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            setOffset(0);
            setApplied(query.trim());
          }}
          className="w-64 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={() => {
            setOffset(0);
            setApplied(query.trim());
          }}
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
        >
          Search
        </button>
        <span className="ml-auto text-xs text-zinc-500">
          {page.total === 0
            ? "no events"
            : `${offset + 1}–${shownTo} of ${page.total}${loading ? " · loading…" : ""}`}
        </span>
      </div>

      {page.items.length === 0 ? (
        <p className="text-sm text-zinc-600">Nothing recorded for this filter.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
          {page.items.map((event) => (
            <li key={event.id} className="px-4 py-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-zinc-400">{event.type}</span>
                {event.source && <span className="text-xs text-zinc-600">{event.source}</span>}
                <span className="ml-auto text-xs text-zinc-600">
                  {new Date(event.occurredAt).toLocaleString()}
                </span>
                {/* Whether the consolidation job has folded this in yet — the
                    difference between "not summarized" and "not recorded". */}
                {!event.processedAt && (
                  <span className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-500">new</span>
                )}
              </div>
              {event.payload && (
                <p className="mt-0.5 break-all font-mono text-xs text-zinc-500">
                  {summarize(event.payload)}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          Newer
        </button>
        <button
          type="button"
          disabled={shownTo >= page.total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
          className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
        >
          Older
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
