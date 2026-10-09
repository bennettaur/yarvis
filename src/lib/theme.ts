import { useSyncExternalStore } from "react";

/**
 * The app's colour theme. `default` is Tailwind's own palette, which the app
 * was designed in; `palenight` retints it (see the `data-theme` block in
 * `index.css`). Chosen in Settings → Appearance and kept per machine, like the
 * app's other view preferences.
 */
export const COLOR_THEMES = [
  { key: "default", label: "Default" },
  { key: "palenight", label: "Palenight" },
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number]["key"];

const STORAGE_KEY = "yarvis.colorTheme";

/** A stored value from another build, or a hand edit, falls back to the default. */
export function parseColorTheme(raw: unknown): ColorTheme {
  return COLOR_THEMES.some((t) => t.key === raw) ? (raw as ColorTheme) : "default";
}

let current: ColorTheme | null = null;
const listeners = new Set<() => void>();

export function getColorTheme(): ColorTheme {
  if (current === null) {
    try {
      current = parseColorTheme(localStorage.getItem(STORAGE_KEY));
    } catch {
      current = "default";
    }
  }
  return current;
}

/**
 * Puts the theme on the root element, where the CSS reads it. Called before
 * the first render as well as on every change, so a Palenight user does not
 * see the default palette for a frame at launch.
 */
export function applyColorTheme(): void {
  document.documentElement.dataset.theme = getColorTheme();
}

export function setColorTheme(theme: ColorTheme): void {
  if (theme === getColorTheme()) return;
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Unpersisted is fine: the theme still applies for this run.
  }
  applyColorTheme();
  for (const listener of listeners) listener();
}

/** Calls `listener` after each change; for surfaces styled from JS. Returns the unsubscribe. */
export function onColorTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useColorTheme(): ColorTheme {
  return useSyncExternalStore(onColorTheme, getColorTheme);
}
