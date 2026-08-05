import { useCallback, useEffect, useState } from "react";
import { type ClipboardHistoryItem, readClipboardHistory, scanClipboardTexts } from "./clipboard";

/**
 * Clipboard history, screened before it reaches the screen.
 *
 * A clipboard carries whatever was copied last, so history is the one place in
 * the feature where a credential arrives without the user choosing to store it.
 * Flagged clips are dropped here rather than rendered greyed-out: the point is
 * not to put a password back on screen in a searchable list. The count of what
 * was dropped is kept so the palette can say so instead of silently showing
 * less than the user copied.
 */

export interface ScreenedHistory {
  items: ClipboardHistoryItem[];
  /** How many clips were withheld because they looked like credentials. */
  hiddenCount: number;
}

const EMPTY: ScreenedHistory = { items: [], hiddenCount: 0 };

export function screenHistory(
  items: ClipboardHistoryItem[],
  flagged: Map<string, string>,
): ScreenedHistory {
  const safe = items.filter((item) => !flagged.has(item.id));
  return { items: safe, hiddenCount: items.length - safe.length };
}

/** Case-insensitive substring match over clip text. */
export function filterHistory(
  items: ClipboardHistoryItem[],
  query: string,
): ClipboardHistoryItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.text.toLowerCase().includes(needle));
}

/**
 * Loads and screens history. If screening fails (the sidecar is down, say) the
 * history is reported as empty: showing unscreened clips would be exactly the
 * leak the screen exists to prevent.
 */
export async function loadScreenedHistory(): Promise<ScreenedHistory> {
  const items = await readClipboardHistory();
  const flagged = await scanClipboardTexts(items);
  return screenHistory(items, flagged);
}

/**
 * Reads screened history whenever `active` becomes true — the palette opening is
 * the only moment it matters, so nothing polls in the background.
 */
export function useScreenedHistory(active: boolean): {
  history: ScreenedHistory;
  error: string | null;
  refresh: () => void;
} {
  const [history, setHistory] = useState<ScreenedHistory>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  const refresh = useCallback(() => setReloads((n) => n + 1), []);

  // `reloads` is a trigger rather than an input: bumping it is what re-reads
  // history after the user clears it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on refresh
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    loadScreenedHistory()
      .then((screened) => {
        if (cancelled) return;
        setHistory(screened);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("[clipboard] loading history failed:", e);
        setHistory(EMPTY);
        setError("Clipboard history is unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [active, reloads]);

  return { history, error, refresh };
}
