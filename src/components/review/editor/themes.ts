import type * as Monaco from "monaco-editor";
import { PALENIGHT as P } from "../../../lib/palette";
import type { ColorTheme } from "../../../lib/theme";

type ThemeData = Monaco.editor.IStandaloneThemeData;

/**
 * Monaco parses its colours itself and cannot read the CSS variables the rest
 * of the app is styled with, so these are literals: Tailwind's zinc steps for
 * the default theme.
 */
const ZINC_HEX = {
  950: "#09090b",
  900: "#18181b",
  600: "#52525b",
  400: "#a1a1aa",
  100: "#f4f4f5",
} as const;

/** Palenight's syntax colours, keyed by the token names Monaco's grammars emit. */
const palenightRules: Monaco.editor.ITokenThemeRule[] = [
  { token: "", foreground: P.foreground.slice(1) },
  { token: "comment", foreground: P.comment.slice(1), fontStyle: "italic" },
  { token: "keyword", foreground: P.purple.slice(1) },
  { token: "storage", foreground: P.purple.slice(1) },
  { token: "string", foreground: P.green.slice(1) },
  { token: "string.escape", foreground: P.cyan.slice(1) },
  { token: "regexp", foreground: P.cyan.slice(1) },
  { token: "number", foreground: P.orange.slice(1) },
  { token: "constant", foreground: P.orange.slice(1) },
  { token: "type", foreground: P.yellow.slice(1) },
  { token: "type.identifier", foreground: P.yellow.slice(1) },
  { token: "identifier", foreground: P.foreground.slice(1) },
  { token: "variable", foreground: P.red.slice(1) },
  { token: "predefined", foreground: P.blue.slice(1) },
  { token: "function", foreground: P.blue.slice(1) },
  { token: "delimiter", foreground: P.cyan.slice(1) },
  { token: "operator", foreground: P.cyan.slice(1) },
  { token: "tag", foreground: P.red.slice(1) },
  { token: "metatag", foreground: P.red.slice(1) },
  { token: "attribute.name", foreground: P.yellow.slice(1) },
  { token: "attribute.value", foreground: P.green.slice(1) },
  { token: "key", foreground: P.red.slice(1) },
  { token: "string.key.json", foreground: P.red.slice(1) },
  { token: "string.value.json", foreground: P.green.slice(1) },
  { token: "annotation", foreground: P.yellow.slice(1) },
];

/** `index.css`'s Palenight retint of zinc-900, its panel colour. */
const PALENIGHT_PANEL = "#2f3347";

export const THEMES: Record<"palenight" | "dark" | "light", { name: string; data: ThemeData }> = {
  palenight: {
    name: "yarvis-palenight",
    data: {
      base: "vs-dark",
      inherit: true,
      rules: palenightRules,
      colors: {
        "editor.background": P.background,
        "editor.foreground": P.foreground,
        "editorCursor.foreground": P.cursor,
        "editor.selectionBackground": P.selection,
        "editor.lineHighlightBackground": "#00000000",
        "editor.lineHighlightBorder": "#00000000",
        "editorLineNumber.foreground": P.comment,
        "editorLineNumber.activeForeground": P.foreground,
        "editorGutter.background": P.background,
        "editorWidget.background": PALENIGHT_PANEL,
        "editorHoverWidget.background": PALENIGHT_PANEL,
        "diffEditor.insertedLineBackground": "#c3e88d14",
        "diffEditor.insertedTextBackground": "#c3e88d33",
        "diffEditor.removedLineBackground": "#f0717814",
        "diffEditor.removedTextBackground": "#f0717833",
        "diffEditor.unchangedRegionBackground": PALENIGHT_PANEL,
        "diffEditor.unchangedRegionForeground": P.comment,
      },
    },
  },
  dark: {
    name: "yarvis-dark",
    data: {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": ZINC_HEX[950],
        "editorGutter.background": ZINC_HEX[950],
        "editor.lineHighlightBackground": "#00000000",
        "editor.lineHighlightBorder": "#00000000",
        "editorLineNumber.foreground": ZINC_HEX[600],
        "editorLineNumber.activeForeground": ZINC_HEX[400],
        "editorWidget.background": ZINC_HEX[900],
        "editorHoverWidget.background": ZINC_HEX[900],
        "diffEditor.insertedLineBackground": "#10b98114",
        "diffEditor.insertedTextBackground": "#10b98133",
        "diffEditor.removedLineBackground": "#ef444414",
        "diffEditor.removedTextBackground": "#ef444433",
        "diffEditor.unchangedRegionBackground": ZINC_HEX[900],
        "diffEditor.unchangedRegionForeground": ZINC_HEX[400],
      },
    },
  },
  light: {
    name: "yarvis-light",
    data: {
      base: "vs",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#ffffff",
        "editor.lineHighlightBackground": "#00000000",
        "editor.lineHighlightBorder": "#00000000",
        "diffEditor.insertedLineBackground": "#10b9811a",
        "diffEditor.insertedTextBackground": "#10b98140",
        "diffEditor.removedLineBackground": "#ef44441a",
        "diffEditor.removedTextBackground": "#ef444440",
        "diffEditor.unchangedRegionBackground": ZINC_HEX[100],
      },
    },
  },
};

export function defineThemes(monaco: typeof Monaco): void {
  for (const { name, data } of Object.values(THEMES)) monaco.editor.defineTheme(name, data);
}

/**
 * The Monaco theme for the app's colour theme. Both of the app's themes are
 * dark today; the light Monaco theme is defined so a light app theme only has
 * to be mapped here.
 */
export function monacoThemeFor(theme: ColorTheme): string {
  return theme === "palenight" ? THEMES.palenight.name : THEMES.dark.name;
}
