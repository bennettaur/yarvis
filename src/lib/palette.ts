import type { ColorTheme } from "./theme";

/**
 * The zinc steps for surfaces styled from JS rather than the class list
 * (CodeMirror's theme). They are the same CSS variables the classes read, so
 * those surfaces follow the colour theme without being rebuilt.
 */
export const ZINC = {
  950: "var(--color-zinc-950)",
  900: "var(--color-zinc-900)",
  800: "var(--color-zinc-800)",
  600: "var(--color-zinc-600)",
  400: "var(--color-zinc-400)",
} as const;

/** Material Palenight's syntax colours, for the editor and the terminal's ANSI set. */
export const PALENIGHT = {
  background: "#292d3e",
  foreground: "#a6accd",
  comment: "#676e95",
  red: "#f07178",
  orange: "#f78c6c",
  yellow: "#ffcb6b",
  green: "#c3e88d",
  cyan: "#89ddff",
  blue: "#82aaff",
  purple: "#c792ea",
  white: "#eeffff",
  cursor: "#ffcc00",
  selection: "#717cb450",
} as const;

/**
 * The terminal's colours per theme. xterm parses its colours itself and cannot
 * read a CSS variable, so these are literals. The default theme names only the
 * background and text and leaves the ANSI set to xterm, as the app always did.
 */
export const TERMINAL_THEMES: Record<ColorTheme, Record<string, string>> = {
  default: { background: "#09090b", foreground: "#e4e4e7" },
  palenight: {
    background: PALENIGHT.background,
    foreground: PALENIGHT.foreground,
    cursor: PALENIGHT.cursor,
    cursorAccent: PALENIGHT.background,
    selectionBackground: PALENIGHT.selection,
    black: "#292d3e",
    red: PALENIGHT.red,
    green: PALENIGHT.green,
    yellow: PALENIGHT.yellow,
    blue: PALENIGHT.blue,
    magenta: PALENIGHT.purple,
    cyan: PALENIGHT.cyan,
    white: "#d0d0d0",
    brightBlack: "#676e95",
    brightRed: "#ff8b92",
    brightGreen: "#ddffa7",
    brightYellow: "#ffe585",
    brightBlue: "#9cc4ff",
    brightMagenta: "#e1acff",
    brightCyan: "#a3f7ff",
    brightWhite: "#ffffff",
  },
};
