/**
 * Syntax colouring for the code views, on top of highlight.js.
 *
 * Everything here is synchronous and bundled: the app runs under a
 * `script-src 'self'` CSP with no `wasm-unsafe-eval`, which rules out the
 * WASM-backed highlighters, and a diff row has to paint in the same commit as
 * the rest of the row or the file would visibly re-colour after it appears.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import clojure from "highlight.js/lib/languages/clojure";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import go from "highlight.js/lib/languages/go";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import objectivec from "highlight.js/lib/languages/objectivec";
import perl from "highlight.js/lib/languages/perl";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import protobuf from "highlight.js/lib/languages/protobuf";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * The grammars the code views can colour. Registered one by one rather than
 * pulling highlight.js's default entry point, which bundles ~190 languages —
 * an order of magnitude more code than this list, nearly all of it for
 * languages no repo we open is written in.
 */
const GRAMMARS = {
  bash,
  c,
  clojure,
  cpp,
  csharp,
  css,
  dart,
  dockerfile,
  elixir,
  erlang,
  go,
  haskell,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  makefile,
  markdown,
  objectivec,
  perl,
  php,
  powershell,
  protobuf,
  python,
  ruby,
  rust,
  scala,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  hljs.registerLanguage(name, grammar);
}

/** File extension (lowercased, no dot) to the grammar that reads it. */
const BY_EXTENSION: Record<string, keyof typeof GRAMMARS> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  clj: "clojure",
  cljs: "clojure",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  erl: "erlang",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hs: "haskell",
  htm: "xml",
  html: "xml",
  hxx: "cpp",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  m: "objectivec",
  markdown: "markdown",
  md: "markdown",
  mjs: "javascript",
  mk: "makefile",
  mm: "objectivec",
  mts: "typescript",
  php: "php",
  pl: "perl",
  pm: "perl",
  proto: "protobuf",
  ps1: "powershell",
  py: "python",
  pyi: "python",
  rb: "ruby",
  rake: "ruby",
  rs: "rust",
  sass: "scss",
  sbt: "scala",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  // TOML is close enough to INI that the key/value/section colouring lands;
  // highlight.js has no TOML grammar of its own.
  toml: "ini",
  ts: "typescript",
  // The TypeScript grammar inherits JavaScript's, which reads JSX.
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

/** Whole filenames that carry the language instead of an extension. */
const BY_FILENAME: Record<string, keyof typeof GRAMMARS> = {
  brewfile: "ruby",
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "makefile",
  podfile: "ruby",
  rakefile: "ruby",
};

/**
 * Where colouring stops being worth its cost. A file past any of these is
 * generated, minified or a data blob — output nobody reads a token at a time,
 * and the size that makes it unreadable is the size that makes tokenising it
 * stall the render. Dropping highlighting there rather than degrading it is
 * what GitHub does with the same class of file.
 */
const MAX_HIGHLIGHT_CHARS = 400_000;
const MAX_HIGHLIGHT_LINES = 20_000;
/**
 * A single line this long is a minified bundle whose newlines were stripped —
 * the whole file can arrive under the character cap and still be one line that
 * sends the grammar's regexes into heavy backtracking.
 */
const MAX_LINE_CHARS = 2_000;

/** The grammar for a path, or null when we have none for it. */
export function languageForPath(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}

/** Whether a document is small enough to be worth colouring at all. */
function worthHighlighting(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  let lineStart = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== "\n") continue;
    if (i - lineStart > MAX_LINE_CHARS) return false;
    lineStart = i + 1;
    lines++;
    if (lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return code.length - lineStart <= MAX_LINE_CHARS;
}

/**
 * Reopens the spans that were still open at a newline on the line below.
 *
 * highlight.js colours a whole document at once and freely spans lines — a
 * block comment or a template literal is one `<span>` — but the code views
 * render one element per line, so a line's markup has to stand on its own.
 * Splitting on `\n` alone would leave unbalanced tags on every line of a
 * multi-line token.
 */
function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  let last = 0;
  // highlight.js emits nothing but `<span class="…">`, `</span>` and escaped
  // text, so tags never nest inside an attribute and never self-close.
  const pattern = /<\/?[^>]*>|\n/g;
  let match = pattern.exec(html);
  while (match !== null) {
    current += html.slice(last, match.index);
    last = match.index + match[0].length;
    if (match[0] === "\n") {
      lines.push(current + "</span>".repeat(open.length));
      current = open.join("");
    } else if (match[0].startsWith("</")) {
      open.pop();
      current += match[0];
    } else {
      open.push(match[0]);
      current += match[0];
    }
    match = pattern.exec(html);
  }
  lines.push(current + html.slice(last) + "</span>".repeat(open.length));
  return lines;
}

/**
 * Colours a whole document and returns it as one HTML string per line, or null
 * when it is too large to be worth tokenising.
 *
 * Whole-document rather than line-by-line because a line is not a self-contained
 * piece of syntax: the body of a block comment or of a multi-line string only
 * reads as one on its own if the lexer has seen where it started.
 */
export function highlightLines(code: string, language: string): string[] | null {
  if (!worthHighlighting(code)) return null;
  if (!hljs.getLanguage(language)) return null;
  // A diff shows a file mid-edit, so syntax that doesn't parse is expected and
  // must not throw away the colouring of everything around it.
  const { value } = hljs.highlight(code, { language, ignoreIllegals: true });
  return splitLines(value);
}
