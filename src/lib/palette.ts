/**
 * Material Palenight, for the surfaces styled from JS rather than the class
 * list (CodeMirror's theme, xterm's). `ZINC` mirrors the `--color-zinc-*`
 * overrides in `index.css`, so a palette change updates both.
 */
export const ZINC = {
  950: "#292d3e",
  900: "#2f3347",
  800: "#3a3f58",
  400: "#a6accd",
} as const;

/** Palenight's syntax colours, shared by the editor and the terminal's ANSI set. */
export const PALENIGHT = {
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

/** The terminal's colours, so Claude Code and shell output render in the theme too. */
export const TERMINAL_THEME = {
  background: ZINC[950],
  foreground: PALENIGHT.foreground,
  cursor: PALENIGHT.cursor,
  cursorAccent: ZINC[950],
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
} as const;
