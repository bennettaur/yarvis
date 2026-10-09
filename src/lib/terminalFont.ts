/**
 * The font every terminal renders with, and the one size they all share. The
 * Terminal tab and each workspace's agent session are the same `TerminalPanel`,
 * so a size change applies to every open terminal at once and is remembered
 * across restarts.
 */

/**
 * Menlo rather than SF Mono: rounder and more open at reading sizes, which
 * matters because an agent session is mostly prose. It stays monospace because
 * xterm.js lays text out on a fixed cell grid — a proportional font is squeezed
 * into equal-width cells, which letter-spaces every word and breaks the TUI's
 * boxes and columns.
 */
export const TERMINAL_FONT_FAMILY = "Menlo, ui-monospace, SFMono-Regular, Monaco, monospace";

export const DEFAULT_TERMINAL_FONT_SIZE = 16;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 32;

const STORAGE_KEY = "yarvis.terminalFontSize";

const clamp = (size: number) =>
  Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));

function readStored(): number {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT_TERMINAL_FONT_SIZE;
  } catch {
    return DEFAULT_TERMINAL_FONT_SIZE;
  }
}

let current: number | null = null;
const listeners = new Set<(size: number) => void>();

export function getTerminalFontSize(): number {
  current ??= readStored();
  return current;
}

export function setTerminalFontSize(size: number): void {
  const next = clamp(size);
  if (next === getTerminalFontSize()) return;
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Unpersisted is fine: the size still applies for this run.
  }
  for (const listener of listeners) listener(next);
}

/** Calls `listener` with each new size; returns the unsubscribe. */
export function onTerminalFontSize(listener: (size: number) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type FontSizeStep = "increase" | "decrease" | "reset";

/** The parts of a `KeyboardEvent` the decision depends on. */
type FontSizeKeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">;

/**
 * Cmd+= / Cmd+- / Cmd+0, the macOS zoom chords. Cmd only, like the other
 * terminal shortcuts: Ctrl+- reaches the PTY as the same byte as Ctrl+_, which
 * is undo in Claude Code and readline. `+` and `_` are accepted for a Shift
 * held by accident, since some layouts report the shifted glyph.
 */
export function resolveFontSizeKey(event: FontSizeKeyEvent): FontSizeStep | null {
  if (!event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key === "=" || event.key === "+") return "increase";
  if (event.key === "-" || event.key === "_") return "decrease";
  if (event.key === "0") return "reset";
  return null;
}

export function stepTerminalFontSize(step: FontSizeStep): void {
  if (step === "reset") setTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE);
  else setTerminalFontSize(getTerminalFontSize() + (step === "increase" ? 1 : -1));
}
