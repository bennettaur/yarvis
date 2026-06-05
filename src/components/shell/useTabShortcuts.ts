import { useEffect } from "react";
import { NAV_ITEMS, type Tab } from "./nav";

/** All tabs in rail order — the cycle order. */
const ORDERED: Tab[] = NAV_ITEMS.map((i) => i.id);
/** Top (non-pinned) tabs — the Cmd+1..9 targets. */
const TOP: Tab[] = NAV_ITEMS.filter((i) => !i.pinBottom).map((i) => i.id);

/** The subset of a keyboard event {@link resolveTabShortcut} needs. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Maps a keyboard event to the tab it should switch to, or null if it isn't a
 * tab shortcut. Cmd/Ctrl+1..9 jump to the Nth top-level tab; Cmd/Ctrl+Shift+]
 * / +[ cycle forward / back across all tabs, wrapping around. Pure so the index
 * math is unit-testable without a DOM.
 */
export function resolveTabShortcut(e: ShortcutEvent, current: Tab): Tab | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey) return null;

  if (e.shiftKey) {
    // With Shift held the bracket keys report their shifted glyphs on some
    // layouts, so accept both forms.
    const dir = e.key === "]" || e.key === "}" ? 1 : e.key === "[" || e.key === "{" ? -1 : 0;
    if (dir === 0) return null;
    const idx = ORDERED.indexOf(current);
    const base = idx === -1 ? 0 : idx;
    const next = (base + dir + ORDERED.length) % ORDERED.length;
    return ORDERED[next] ?? null;
  }

  const n = Number.parseInt(e.key, 10);
  if (Number.isInteger(n) && n >= 1 && n <= 9) {
    return TOP[n - 1] ?? null;
  }
  return null;
}

/**
 * Window-level keyboard navigation between tabs. Listens in the capture phase so
 * the Terminal's xterm doesn't swallow the combos first, and only consumes
 * events that resolve to a tab — all other keystrokes pass through untouched.
 */
export function useTabShortcuts(current: Tab, setTab: (tab: Tab) => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = resolveTabShortcut(e, current);
      if (target) {
        e.preventDefault();
        setTab(target);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, setTab]);
}
