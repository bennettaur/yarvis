/**
 * The single catalogue of keyboard shortcuts the app answers to, and the
 * formatting rules for showing them. The cheat sheet renders this list, so a
 * shortcut added to a handler has to be added here too or it stays invisible.
 */

/**
 * A key in a chord. `Mod` is the primary app modifier (Cmd); `Ctrl` is the
 * literal Control key, which the machine-wide hotkeys use so they stay clear of
 * the app's own Cmd combos.
 */
export type KeyToken = string;

const GLYPHS: Record<string, string> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Shift: "⇧",
  Alt: "⌥",
};

/** The modifier that, held on its own, reveals the nav rail's shortcut hints. */
export const HINT_MODIFIER_KEY = "Meta";

export interface Shortcut {
  keys: KeyToken[];
  description: string;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["Mod", "1"], description: "Jump to the first view in the rail (2…9 for the rest)" },
      { keys: ["Mod", "Shift", "]"], description: "Next view" },
      { keys: ["Mod", "Shift", "["], description: "Previous view" },
      { keys: ["Mod", "/"], description: "Show this cheat sheet" },
      { keys: ["Mod"], description: "Hold to label the rail with its shortcuts" },
    ],
  },
  {
    title: "Find on page",
    shortcuts: [
      { keys: ["Mod", "F"], description: "Find in the current view" },
      { keys: ["Mod", "G"], description: "Next match" },
      { keys: ["Mod", "Shift", "G"], description: "Previous match" },
    ],
  },
  {
    title: "Terminal",
    shortcuts: [
      { keys: ["Mod", "T"], description: "New terminal tab" },
      { keys: ["Mod", "W"], description: "Close the terminal tab" },
      { keys: ["Mod", "D"], description: "Split the pane to the right" },
      { keys: ["Mod", "Shift", "D"], description: "Split the pane below" },
    ],
  },
  {
    title: "Anywhere on the machine",
    shortcuts: [
      { keys: ["Ctrl", "Shift", "Space"], description: "Summon Omni Chat" },
      { keys: ["Ctrl", "Shift", "V"], description: "Summon the clipboard palette" },
    ],
  },
  {
    title: "Overlays",
    shortcuts: [{ keys: ["Esc"], description: "Close the overlay you are in" }],
  },
];

/** The chord as it should read on screen, e.g. `["Mod", "Shift", "]"]` → "⌘⇧]". */
export function formatChord(keys: KeyToken[]): string {
  return keys.map((key) => GLYPHS[key] ?? key).join("");
}

/** Opens the cheat sheet: Cmd+/ (the key the "?" lives on). */
export function isCheatSheetShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key === "/";
}
