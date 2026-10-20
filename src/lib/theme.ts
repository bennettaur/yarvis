import { useSyncExternalStore } from "react";
import { saveColorTheme } from "./settings";

/**
 * The app's colour theme. `default` is Tailwind's own palette, which the app
 * was designed in; `palenight` retints it (see the `data-theme` block in
 * `index.css`). Chosen in Settings → Appearance and kept in `settings.json`,
 * so it survives a restart and is shared by every instance of the app.
 */
export const COLOR_THEMES = [
  { key: "default", label: "Default" },
  { key: "palenight", label: "Palenight" },
] as const;

export type ColorTheme = (typeof COLOR_THEMES)[number]["key"];

/** A stored value from another build, or a hand edit, falls back to the default. */
export function parseColorTheme(raw: unknown): ColorTheme {
  return COLOR_THEMES.some((t) => t.key === raw) ? (raw as ColorTheme) : "default";
}

let current: ColorTheme = "default";
const listeners = new Set<() => void>();
// Saves run one after another, so the file ends on the last choice even when
// two are made faster than a save completes.
let saving: Promise<unknown> = Promise.resolve();

export function getColorTheme(): ColorTheme {
  return current;
}

/**
 * Puts the theme on the root element, where the CSS reads it. Called before
 * the first render as well as on every change, so a Palenight user does not
 * see the default palette for a frame at launch.
 */
export function applyColorTheme(): void {
  document.documentElement.dataset.theme = current;
}

/** Takes the stored theme at launch, from `settings.json`'s `colorTheme`. */
export function loadColorTheme(raw: unknown): void {
  current = parseColorTheme(raw);
  applyColorTheme();
}

/**
 * Applies the theme straight away and saves it to `settings.json`. Rejects
 * only when the save failed, in which case the theme still holds until the app
 * restarts.
 */
export function setColorTheme(theme: ColorTheme): Promise<void> {
  if (theme === current) return Promise.resolve();
  current = theme;
  applyColorTheme();
  for (const listener of listeners) listener();
  const save = saving.then(() => saveColorTheme(theme === "default" ? null : theme));
  saving = save.catch(() => {});
  return save.then(() => {});
}

/** Calls `listener` after each change; for surfaces styled from JS. Returns the unsubscribe. */
export function onColorTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useColorTheme(): ColorTheme {
  return useSyncExternalStore(onColorTheme, getColorTheme);
}
