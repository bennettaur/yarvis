import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ClipboardEntry,
  type ClipboardHistoryItem,
  clearClipboardHistory,
  createClipboardEntry,
  deleteClipboardEntry,
  listClipboardEntries,
  markClipboardEntryUsed,
  updateClipboardEntry,
  writeClipboard,
} from "../../lib/clipboard";
import { filterHistory, useScreenedHistory } from "../../lib/clipboardHistory";
import { formatRelativeTime } from "../../lib/time";
import ClipboardEntryForm, { type ClipboardDraft } from "./ClipboardEntryForm";

/**
 * The clipboard palette: a summon-from-anywhere overlay for copying a saved
 * snippet, or fishing something back out of clipboard history.
 *
 * Search is typed straight into the list — arrows move the selection, Enter
 * copies and closes — so the whole flow is one keystroke sequence with no mouse.
 * Saved entries come from the sidecar (which does the matching); history is
 * already in memory, so it is filtered here.
 *
 * Unlike Omni Chat this unmounts when hidden. There is nothing to keep running
 * in the background, and a fresh mount means a fresh search box every summon.
 */

/** How long typing settles before the entry list is re-queried. */
const SEARCH_DEBOUNCE_MS = 120;

/** Longest preview shown for a snippet; the rest is one line, whitespace collapsed. */
const PREVIEW_LENGTH = 140;

type Row =
  | { kind: "entry"; key: string; entry: ClipboardEntry }
  | { kind: "clip"; key: string; item: ClipboardHistoryItem };

function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_LENGTH ? `${oneLine.slice(0, PREVIEW_LENGTH)}…` : oneLine;
}

/** Seeds a new entry's label from the clip itself, which is usually right. */
function draftFromClip(item: ClipboardHistoryItem): ClipboardDraft {
  return { label: preview(item.text).slice(0, 60), content: item.text, tags: "" };
}

function draftFromEntry(entry: ClipboardEntry): ClipboardDraft {
  return { label: entry.label, content: entry.content, tags: entry.tags.join(", ") };
}

export default function ClipboardPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  /** The entry being edited, or "new" for a blank create form; null when closed. */
  const [editing, setEditing] = useState<{ id: string | null; draft: ClipboardDraft } | null>(null);
  const [reloads, setReloads] = useState(0);

  const { history, error: historyError, refresh: refreshHistory } = useScreenedHistory(open);
  const inputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  // Re-query on open and as the search settles. The debounce keeps a fast typist
  // from firing a request per keystroke. `reloads` is a trigger rather than an
  // input: bumping it is what re-reads the list after an edit or a delete.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on reload
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      listClipboardEntries(query)
        .then((rows) => {
          if (cancelled) return;
          setEntries(rows);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          console.error("[clipboard] loading entries failed:", e);
          setEntries([]);
          setError("Saved entries are unavailable.");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, reloads]);

  // Reset the search and selection between summons so the palette always opens
  // ready for a fresh query.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      return;
    }
    setQuery("");
    setSelected(0);
    setEditing(null);
    setError(null);
  }, [open]);

  const clips = useMemo(() => filterHistory(history.items, query), [history.items, query]);

  const rows = useMemo<Row[]>(
    () => [
      ...entries.map((entry): Row => ({ kind: "entry", key: `entry:${entry.id}`, entry })),
      ...clips.map((item): Row => ({ kind: "clip", key: `clip:${item.id}`, item })),
    ],
    [entries, clips],
  );

  // A shrinking list must not leave the selection past its end.
  const activeIndex = rows.length === 0 ? 0 : Math.min(selected, rows.length - 1);

  const copy = useCallback(
    async (row: Row) => {
      try {
        if (row.kind === "entry") {
          await writeClipboard(row.entry.content);
          // Ordering is a nicety; a failed bump must not swallow a good copy.
          markClipboardEntryUsed(row.entry.id).catch((e) => {
            console.error("[clipboard] recording the use failed:", e);
          });
        } else {
          await writeClipboard(row.item.text);
        }
        onClose();
      } catch (e) {
        console.error("[clipboard] writing to the clipboard failed:", e);
        setError("Copying to the clipboard failed.");
      }
    },
    [onClose],
  );

  const remove = useCallback(
    async (entry: ClipboardEntry) => {
      try {
        await deleteClipboardEntry(entry.id);
        reload();
      } catch (e) {
        console.error("[clipboard] deleting the entry failed:", e);
        setError("Deleting that entry failed.");
      }
    },
    [reload],
  );

  const togglePinned = useCallback(
    async (entry: ClipboardEntry) => {
      try {
        await updateClipboardEntry(entry.id, { pinned: !entry.pinned });
        reload();
      } catch (e) {
        console.error("[clipboard] pinning the entry failed:", e);
        setError("Pinning that entry failed.");
      }
    },
    [reload],
  );

  const saveDraft = useCallback(
    async (input: Parameters<typeof createClipboardEntry>[0]) => {
      const id = editing?.id;
      if (id) {
        await updateClipboardEntry(id, input);
      } else {
        await createClipboardEntry(input);
      }
      setEditing(null);
      reload();
    },
    [editing, reload],
  );

  const forgetHistory = useCallback(async () => {
    try {
      await clearClipboardHistory();
      refreshHistory();
    } catch (e) {
      console.error("[clipboard] clearing history failed:", e);
      setError("Clearing the history failed.");
    }
  }, [refreshHistory]);

  // Esc closes from wherever focus happens to be, so it works while the user is
  // in a form field too. It backs out of the form first, so an accidental Esc
  // mid-edit doesn't throw away the whole palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (editing) setEditing(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editing, onClose]);

  /**
   * List navigation, bound to the search box rather than the whole panel: a row's
   * own buttons must keep Enter for themselves, so the palette only claims it
   * while the user is typing a query.
   */
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected(rows.length === 0 ? 0 : (activeIndex + 1) % rows.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(rows.length === 0 ? 0 : (activeIndex - 1 + rows.length) % rows.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[activeIndex];
      if (row) void copy(row);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
      {/* Clicking anywhere outside the panel hides it; a button keeps that
          keyboard-accessible, matching the Omni Chat overlay. */}
      <button
        type="button"
        aria-label="Close clipboard palette"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/40"
      />
      <div className="relative z-10 flex max-h-[70vh] w-[680px] max-w-[92vw] flex-col gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 text-zinc-100 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-300">Clipboard</span>
          <button
            type="button"
            onClick={() => setEditing({ id: null, draft: { label: "", content: "", tags: "" } })}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            New entry
          </button>
          <button
            type="button"
            onClick={() => void forgetHistory()}
            className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Clear history
          </button>
        </div>

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          onKeyDown={onSearchKeyDown}
          placeholder="Search saved entries and clipboard history…"
          aria-label="Search the clipboard"
          className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
        />

        {editing && (
          <ClipboardEntryForm
            draft={editing.draft}
            submitLabel={editing.id ? "Save changes" : "Save entry"}
            onSubmit={saveDraft}
            onCancel={() => setEditing(null)}
          />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
        {historyError && <p className="text-xs text-amber-300">{historyError}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 ? (
            <p className="px-1 py-6 text-center text-sm text-zinc-500">
              {query ? "Nothing matches that." : "Nothing saved yet — copy something, or add it."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((row, index) => (
                <li key={row.key}>
                  {row.kind === "entry" ? (
                    <EntryRow
                      entry={row.entry}
                      active={index === activeIndex}
                      onCopy={() => void copy(row)}
                      onEdit={() =>
                        setEditing({ id: row.entry.id, draft: draftFromEntry(row.entry) })
                      }
                      onTogglePinned={() => void togglePinned(row.entry)}
                      onDelete={() => void remove(row.entry)}
                    />
                  ) : (
                    <ClipRow
                      item={row.item}
                      active={index === activeIndex}
                      onCopy={() => void copy(row)}
                      onSave={() => setEditing({ id: null, draft: draftFromClip(row.item) })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="text-xs text-zinc-600">
          ↑↓ to move · Enter to copy · Esc to close
          {history.hiddenCount > 0 &&
            ` · ${history.hiddenCount} clip${history.hiddenCount === 1 ? "" : "s"} hidden (looked like credentials)`}
        </p>
      </div>
    </div>
  );
}

function rowClasses(active: boolean): string {
  return `group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${
    active ? "bg-indigo-600/20" : "hover:bg-zinc-800/50"
  }`;
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded px-1 py-0.5 text-xs text-zinc-500 opacity-0 hover:text-indigo-300 focus:opacity-100 group-hover:opacity-100"
    >
      {children}
    </button>
  );
}

function EntryRow({
  entry,
  active,
  onCopy,
  onEdit,
  onTogglePinned,
  onDelete,
}: {
  entry: ClipboardEntry;
  active: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onTogglePinned: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={rowClasses(active)}>
      <button type="button" onClick={onCopy} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          {entry.pinned && (
            <span className="shrink-0 text-xs text-amber-300" aria-hidden="true">
              ★
            </span>
          )}
          <span className="truncate text-sm text-zinc-100">{entry.label}</span>
          {entry.tags.map((tag) => (
            <span key={tag} className="shrink-0 rounded bg-zinc-800 px-1 text-xs text-zinc-400">
              {tag}
            </span>
          ))}
        </span>
        <span className="block truncate font-mono text-xs text-zinc-500">
          {preview(entry.content)}
        </span>
      </button>
      <RowAction label={entry.pinned ? "Unpin entry" : "Pin entry"} onClick={onTogglePinned}>
        {entry.pinned ? "Unpin" : "Pin"}
      </RowAction>
      <RowAction label="Edit entry" onClick={onEdit}>
        Edit
      </RowAction>
      <RowAction label="Delete entry" onClick={onDelete}>
        Delete
      </RowAction>
    </div>
  );
}

function ClipRow({
  item,
  active,
  onCopy,
  onSave,
}: {
  item: ClipboardHistoryItem;
  active: boolean;
  onCopy: () => void;
  onSave: () => void;
}) {
  return (
    <div className={rowClasses(active)}>
      <button type="button" onClick={onCopy} className="min-w-0 flex-1 text-left">
        <span className="block truncate font-mono text-xs text-zinc-300">{preview(item.text)}</span>
        <span className="block text-xs text-zinc-600">
          from history · {formatRelativeTime(new Date(item.capturedAtMs).toISOString())}
        </span>
      </button>
      <RowAction label="Save this clip as an entry" onClick={onSave}>
        Save
      </RowAction>
    </div>
  );
}
