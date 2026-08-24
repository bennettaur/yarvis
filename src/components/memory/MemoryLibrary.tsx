import { useCallback, useEffect, useState } from "react";
import type { ProviderId } from "../../lib/chat";
import {
  type MemoryKind,
  type MemoryRecord,
  memAddNote,
  memDelete,
  memIngest,
  memList,
  memRecap,
  memSearch,
  type RecapResult,
} from "../../lib/memory";
import Markdown from "../Markdown";

// The chat panel persists the last-used model here; recaps reuse it so the
// summary matches the provider the user already configured.
const PROVIDER_KEY = "yarvis.chat.provider";
const MODEL_KEY = "yarvis.chat.model";

function kindColor(kind: string): string {
  if (kind === "note") return "bg-sky-900 text-sky-200";
  if (kind === "doc") return "bg-purple-900 text-purple-200";
  if (kind.endsWith("summary")) return "bg-emerald-900 text-emerald-200";
  if (kind === "project") return "bg-amber-900 text-amber-200";
  return "bg-zinc-700 text-zinc-300";
}

function MemoryItem({ m, onDelete }: { m: MemoryRecord; onDelete: (id: string) => void }) {
  const source = (m.metadata as { source?: string } | null)?.source;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className={`rounded px-1.5 py-0.5 text-xs ${kindColor(m.kind)}`}>{m.kind}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-200">{m.content}</p>
        <div className="mt-0.5 text-xs text-zinc-600">
          {new Date(m.createdAt).toLocaleString()}
          {source ? ` · ${source}` : ""}
          {m.score != null ? ` · ${(m.score * 100).toFixed(0)}% match` : ""}
        </div>
      </div>
      <button
        onClick={() => onDelete(m.id)}
        className="text-zinc-600 hover:text-red-400"
        title="Delete"
      >
        ✕
      </button>
    </li>
  );
}

/** The kinds worth offering as a filter, in the order they matter to a reader. */
const FILTER_KINDS: MemoryKind[] = [
  "fact",
  "preference",
  "note",
  "project",
  "decision",
  "agent-feedback",
  "day-summary",
  "activity-summary",
  "session-summary",
  "doc",
];

/** Page size for the browse; a summary a day adds up over a few months. */
const PAGE_SIZE = 50;

export default function MemoryLibrary() {
  const [items, setItems] = useState<MemoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<MemoryKind | "">("");
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState("");
  const [ingestUrl, setIngestUrl] = useState("");
  const [ingestText, setIngestText] = useState("");
  const [recap, setRecap] = useState<RecapResult | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setSearching(false);
      const page = await memList({
        kinds: kind ? [kind] : undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [kind, offset]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return reload();
    try {
      setSearching(true);
      setItems(await memSearch(q));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [query, reload]);

  const onDelete = useCallback(async (id: string) => {
    await memDelete(id);
    setItems((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const addNote = useCallback(async () => {
    const content = note.trim();
    if (!content) return;
    await memAddNote(content);
    setNote("");
    await reload();
  }, [note, reload]);

  const ingest = useCallback(async () => {
    const url = ingestUrl.trim();
    const text = ingestText.trim();
    if (!url && !text) return;
    setStatus("Ingesting…");
    setError(null);
    try {
      const result = await memIngest(url ? { url } : { text });
      setStatus(`Ingested ${result.chunks} chunk(s) from ${result.source}.`);
      setIngestUrl("");
      setIngestText("");
      await reload();
    } catch (e) {
      setStatus(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [ingestUrl, ingestText, reload]);

  const runRecap = useCallback(async (range: "day" | "week") => {
    setRecapBusy(true);
    setError(null);
    try {
      const provider = localStorage.getItem(PROVIDER_KEY) as ProviderId | null;
      const model = localStorage.getItem(MODEL_KEY);
      setRecap(await memRecap(range, provider ?? undefined, model ?? undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRecapBusy(false);
    }
  }, []);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">Recap</h2>
        <div className="flex gap-2">
          <button
            onClick={() => void runRecap("day")}
            disabled={recapBusy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            Today
          </button>
          <button
            onClick={() => void runRecap("week")}
            disabled={recapBusy}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-50"
          >
            This week
          </button>
        </div>
        {recapBusy && <p className="mt-2 text-sm text-zinc-500">Summarizing…</p>}
        {recap && !recapBusy && (
          <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
              {recap.label} · {recap.tasks.length} task(s) done · {recap.notes.length} note(s)
            </div>
            <Markdown>{recap.recap}</Markdown>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Quick note
        </h2>
        <div className="flex gap-2">
          <input
            value={note}
            placeholder="Jot something down…"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addNote()}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => void addNote()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            Add note
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Ingest document
        </h2>
        <div className="space-y-2">
          <input
            value={ingestUrl}
            placeholder="https://… (fetches and stores the page text)"
            onChange={(e) => setIngestUrl(e.target.value)}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
          />
          <textarea
            value={ingestText}
            placeholder="…or paste text to ingest"
            onChange={(e) => setIngestText(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => void ingest()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
          >
            Ingest
          </button>
          {status && <p className="text-sm text-zinc-500">{status}</p>}
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
            {searching ? "Search results" : "All memories"}
          </h2>
          <select
            value={kind}
            onChange={(e) => {
              setOffset(0);
              setKind(e.target.value as MemoryKind | "");
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          >
            <option value="">All kinds</option>
            {FILTER_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            value={query}
            placeholder="Search memories…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void runSearch()}
            className="ml-auto w-48 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          />
          <button
            onClick={() => void runSearch()}
            className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800"
          >
            Search
          </button>
          {searching && (
            <button
              onClick={() => {
                setQuery("");
                void reload();
              }}
              className="text-sm text-zinc-500 hover:text-zinc-300"
            >
              Clear
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="text-sm text-zinc-600">Nothing stored yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {items.map((m) => (
              <MemoryItem key={m.id} m={m} onDelete={onDelete} />
            ))}
          </ul>
        )}
        {/* Paging applies to the browse, not to a search: a search already
            returns its own ranked top slice. */}
        {!searching && total > PAGE_SIZE && (
          <div className="mt-2 flex items-center gap-2">
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
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => setOffset(offset + PAGE_SIZE)}
              className="rounded-md border border-zinc-700 px-2 py-1 text-sm hover:bg-zinc-800 disabled:opacity-40"
            >
              Older
            </button>
            <span className="text-xs text-zinc-500">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
          </div>
        )}
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
