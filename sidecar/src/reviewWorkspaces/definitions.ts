/**
 * Go-to-definition and find-references for every language, without running
 * anything from the pull request: a `git grep` over the head commit's objects
 * for the symbol as a whole word, then per-language patterns that pick out the
 * lines declaring it. No language server, no checkout reads, no network — the
 * blobs are already local once the PR's checkout is done.
 *
 * Answers are guesses ranked by proximity (the file itself, its directory,
 * what it imports, everything else), which is what a reviewer clicking
 * through wants first; they are not resolved the way a compiler would.
 */

import { posix } from "node:path";
import type { CappedRunResult } from "../workspaces/exec.ts";

/**
 * Identifier characters only, plus the trailing `?` or `!` a Ruby method name
 * may end in: what reaches git is a fixed string and nothing more.
 */
const SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*[?!]?$/;
const MAX_SYMBOL_LENGTH = 200;

export function isValidSymbol(symbol: string): boolean {
  return symbol.length <= MAX_SYMBOL_LENGTH && SYMBOL.test(symbol);
}

/**
 * Language families, each with the extensions it is searched in. A family
 * groups languages that call into each other (Java and Kotlin, C and C++,
 * TypeScript and JavaScript), so a definition across that line is found.
 */
export type LanguageFamily =
  | "python"
  | "go"
  | "rust"
  | "jvm"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "js"
  | "c";

const FAMILY_EXTENSIONS: Record<LanguageFamily, string[]> = {
  python: ["py", "pyi"],
  go: ["go"],
  rust: ["rs"],
  jvm: ["java", "kt", "kts", "scala"],
  csharp: ["cs"],
  ruby: ["rb", "rake"],
  php: ["php"],
  swift: ["swift"],
  js: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  c: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"],
};

const FAMILY_BY_EXTENSION = new Map<string, LanguageFamily>(
  (Object.entries(FAMILY_EXTENSIONS) as [LanguageFamily, string[]][]).flatMap(([family, exts]) =>
    exts.map((ext) => [ext, family] as const),
  ),
);

function extensionOf(path: string): string {
  const name = posix.basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The family a file is searched as, or null for one the patterns don't know. */
export function languageFamilyForPath(path: string): LanguageFamily | null {
  return FAMILY_BY_EXTENSION.get(extensionOf(path)) ?? null;
}

/**
 * Generated and installed code a reviewer never means: minified bundles,
 * source maps and build output. Its matches would bury the real ones and,
 * being huge, eat the output cap.
 */
const EXCLUDED_PATHSPECS = [
  ":(exclude)*.min.*",
  ":(exclude)*.map",
  ...["node_modules", "dist", "build", "out", "target", ".next", "coverage"].map(
    (dir) => `:(exclude,glob)**/${dir}/**`,
  ),
];

/** git pathspecs for a family's files (`*.py` matches at any depth), less generated code. */
export function searchPathspecs(family: LanguageFamily | null): string[] {
  const included = family ? FAMILY_EXTENSIONS[family].map((ext) => `*.${ext}`) : [];
  return [...included, ...EXCLUDED_PATHSPECS];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Declaration patterns for one symbol; a weak match ranks below every strong one. */
export interface DefinitionPatterns {
  strong: RegExp[];
  weak: RegExp[];
}

/**
 * Lines that declare `symbol` in a family's files. Each pattern is written
 * against one source line, so multi-line declarations are found by their
 * first line. `S` is followed by a boundary that also counts `$`, which is an
 * identifier character in JavaScript and PHP. Weak patterns are the ones that
 * can't tell a declaration from an assignment (a Python class attribute), so
 * they are offered after everything else.
 */
export function definitionPatterns(
  family: LanguageFamily | null,
  symbol: string,
): DefinitionPatterns {
  const S = `${escapeRegExp(symbol)}(?![\\w$])`;
  const sources = family ? FAMILY_PATTERNS[family](S) : { strong: genericPatterns(S) };
  return {
    strong: sources.strong.map((source) => new RegExp(source)),
    weak: (sources.weak ?? []).map((source) => new RegExp(source)),
  };
}

/** Words that read like a return type in front of a call but never start a declaration. */
const NOT_A_TYPE = "(?!(?:return|new|throw|else|await|yield|case|in|is|as|not|and|or)\\b)";
const C_LIKE_MODIFIERS =
  "(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|override|virtual|async|sealed|partial|extern|unsafe|new|default|open|inline|const|constexpr|explicit|friend|suspend|operator|data)\\s+)*";
/** Type parameters, nested up to three deep: `<T: Into<Vec<u8>>>`. */
const GENERICS = "<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>";
/** A type as written before a member name: `Map<K, V>`, `int[]`, `Foo.Bar?`. */
const TYPE = `[\\w.?]+(?:${GENERICS})?(?:\\[\\])*`;
const JS_MODIFIERS =
  "(?:(?:public|private|protected|static|async|readonly|abstract|override|declare|get|set|export|default)\\s+)*";
/** The start of an arrow function: `(a, b) =>`, `x =>`, `async () =>`, `<T>(x: T) =>`. */
const ARROW = `(?:async\\s+)?(?:${GENERICS})?(?:\\([^)]*\\)|[\\w$]+)\\s*(?::[^=]+)?=>`;

type PatternSources = { strong: string[]; weak?: string[] };

const FAMILY_PATTERNS: Record<LanguageFamily, (S: string) => PatternSources> = {
  python: (S) => ({
    strong: [`^\\s*(?:async\\s+)?def\\s+${S}`, `^\\s*class\\s+${S}`, `^${S}\\s*(?::[^=]+)?=(?!=)`],
    // A class attribute or a dataclass field — or a local assignment.
    weak: [`^\\s+${S}\\s*:\\s*[\\w\\[."']`, `^\\s+${S}\\s*=(?!=)`],
  }),
  go: (S) => ({
    strong: [
      `^func\\s+(?:\\([^)]*\\)\\s*)?${S}`,
      `^\\s*type\\s+${S}`,
      `^\\s*(?:var|const)\\s+${S}`,
      // One indent inside a `type ( … )`, `const ( … )` or `var ( … )`
      // block. An untyped entry looks like a reassignment in a function body,
      // so only a typed one, or an `iota`, counts.
      `^(?:\\t| {2,4})${S}\\s+(?:struct|interface)\\b`,
      `^(?:\\t| {2,4})${S}\\s+[\\w.*\\[\\]]+\\s*=(?!=)`,
      `^(?:\\t| {2,4})${S}\\s*=\\s*iota\\b`,
    ],
  }),
  rust: (S) => ({
    strong: [
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:(?:async|const|unsafe|extern(?:\\s+"[^"]*")?)\\s+)*fn\\s+${S}`,
      `^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait|type|union|mod|const|static(?:\\s+mut)?)\\s+${S}`,
      `^\\s*macro_rules!\\s*${S}`,
      `^\\s*(?:unsafe\\s+)?impl(?:${GENERICS})?\\s+(?:[\\w:]+(?:${GENERICS})?\\s+for\\s+)?${S}`,
    ],
  }),
  jvm: (S) => ({
    strong: [
      `\\b(?:class|interface|enum|record|object|trait)\\s+${S}`,
      `\\bfun\\s+(?:${GENERICS}\\s*)?(?:[\\w.]+(?:${GENERICS})?\\.)?${S}\\s*\\(`,
      `\\b(?:val|var|def)\\s+${S}`,
      `^\\s*(?:@\\w+(?:\\([^)]*\\))?\\s+)*${C_LIKE_MODIFIERS}(?:${GENERICS}\\s+)?${NOT_A_TYPE}${TYPE}\\s+${S}\\s*\\(`,
    ],
  }),
  csharp: (S) => ({
    strong: [
      `\\b(?:class|interface|enum|record|struct)\\s+${S}`,
      `^\\s*(?:\\[[^\\]]*\\]\\s*)*${C_LIKE_MODIFIERS}${NOT_A_TYPE}${TYPE}\\s+${S}\\s*(?:${GENERICS})?\\s*(?:\\(|\\{|=>)`,
    ],
  }),
  ruby: (S) => ({
    strong: [
      `^\\s*def\\s+(?:self\\.)?${S}`,
      `^\\s*(?:class|module)\\s+(?:[\\w:]+::)?${S}`,
      `^\\s*${S}\\s*=(?!=)`,
      `^\\s*(?:attr_reader|attr_writer|attr_accessor)\\s+.*:${S}`,
    ],
  }),
  php: (S) => ({
    strong: [
      `\\bfunction\\s+&?${S}\\s*\\(`,
      `\\b(?:class|interface|trait|enum)\\s+${S}`,
      `\\bconst\\s+${S}`,
    ],
  }),
  swift: (S) => ({
    strong: [
      `\\b(?:func|class|struct|enum|protocol|extension|typealias|actor)\\s+${S}`,
      `^\\s*(?:(?:public|private|fileprivate|internal|open|static|final)\\s+)*(?:let|var)\\s+${S}`,
    ],
  }),
  js: (S) => ({
    strong: [
      // `import type { S }` names a type; it doesn't declare one.
      `(?<!\\bimport\\s+)\\b(?:function\\*?|class|interface|type|enum|namespace|module)\\s+${S}`,
      `\\b(?:const|let|var)\\s+${S}\\s*[=:]`,
      // A method: `name(…) {`, `async name<T>(…): X {`.
      `^\\s*${JS_MODIFIERS}\\*?${S}\\s*(?:${GENERICS})?\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`,
      // A class field: `private name: T`, `handleClick = () => …`.
      `^\\s*(?:(?:public|private|protected|static|readonly|declare|override)\\s+)+${S}\\s*[?!]?\\s*[:=]`,
      `^\\s*${JS_MODIFIERS}${S}\\s*(?::[^=]+)?=\\s*${ARROW}`,
      // An object-literal member: `name: () => …`, `name: function (…)`.
      `^\\s*${S}\\s*:\\s*(?:${ARROW}|(?:async\\s+)?function\\b)`,
    ],
  }),
  c: (S) => ({
    strong: [
      `\\b(?:struct|class|union|enum|typedef|namespace)\\s+(?:\\w+\\s+)?${S}\\s*(?:[{:;]|$)`,
      `^\\s*#\\s*define\\s+${S}`,
      // A function definition's first line: a return type, the name, and no `;`.
      `^\\s*${C_LIKE_MODIFIERS}${NOT_A_TYPE}(?:[\\w:<>,*&][\\w:<>,*&\\s]*)?[\\w>*&]\\s*[*&]*\\s*(?:\\w+::)*${S}\\s*\\([^;]*$`,
      `^\\s*}\\s*${S}\\s*;`,
    ],
  }),
};

function genericPatterns(S: string): string[] {
  return [
    `\\b(?:def|fn|func|function|fun|sub|proc|class|struct|enum|trait|interface|type|module|impl|protocol|object|record|union|typedef)\\s+${S}`,
    `\\b(?:const|let|var|val)\\s+${S}`,
    `^\\s*#\\s*define\\s+${S}`,
  ];
}

/**
 * A line that is a comment in some language: `//`, `/*`, a `*` continuation,
 * `--`, or `#` (but not a C preprocessor line). A name mentioned in a comment
 * is not where it is declared.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|--|#(?!\s*(?:define|if|ifdef|ifndef|include)\b))/;

/** One line a grep found. */
export interface SymbolMatch {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based UTF-16 column of the symbol, as an editor counts it. */
  column: number;
  /** The line's text, trimmed and shortened for a list. */
  preview: string;
}

/** A line of `git grep -z -n` output against a tree. */
export interface GrepLine {
  path: string;
  line: number;
  text: string;
}

/**
 * Parses `git grep -n -z <rev>` output: `<rev>:<path>\0<line>\0<text>\n`.
 * Read field by field rather than by line, since only the text ends at a
 * newline and a path may hold one.
 */
export function parseGrepOutput(out: string, rev: string): GrepLine[] {
  const lines: GrepLine[] = [];
  const prefix = `${rev}:`;
  let at = 0;
  while (at < out.length) {
    const pathEnd = out.indexOf("\0", at);
    if (pathEnd < 0) break;
    const lineEnd = out.indexOf("\0", pathEnd + 1);
    if (lineEnd < 0) break;
    let textEnd = out.indexOf("\n", lineEnd + 1);
    if (textEnd < 0) textEnd = out.length;
    const rawPath = out.slice(at, pathEnd);
    const line = Number(out.slice(pathEnd + 1, lineEnd));
    if (rawPath.startsWith(prefix) && Number.isInteger(line) && line > 0) {
      lines.push({
        path: rawPath.slice(prefix.length),
        line,
        text: out.slice(lineEnd + 1, textEnd),
      });
    }
    at = textEnd + 1;
  }
  return lines;
}

const PREVIEW_LENGTH = 200;
/** A declaration's first line is short; a minified line isn't worth running patterns over. */
const MAX_LINE_TESTED = 1_000;

/** Turns grep lines into matches, with the column of the symbol as a whole word. */
function toMatches(lines: readonly GrepLine[], symbol: string): SymbolMatch[] {
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(symbol)}(?![\\w$])`);
  return lines.flatMap((found) => {
    const text = found.text.slice(0, MAX_LINE_TESTED);
    const match = word.exec(text);
    if (!match) return [];
    return [
      {
        path: found.path,
        line: found.line,
        column: match.index + 1,
        preview: text.trim().slice(0, PREVIEW_LENGTH),
      },
    ];
  });
}

/** Only the start of a file is read for imports; they live there, and it bounds the work. */
const MAX_IMPORT_SCAN = 64 * 1024;

/**
 * What a file imports, as repo-path fragments (`a/b/c` for Python's
 * `from a.b import c`, `pkg/x` for `"github.com/o/r/pkg/x"`). Only used to
 * rank, so it reads the common forms and lets the rest go. Every pattern stays
 * within a line (`[ \t]`, never `\s`), which keeps each one linear on any
 * input.
 */
export function importHints(fromPath: string, fullContent: string): string[] {
  const content = fullContent.slice(0, MAX_IMPORT_SCAN);
  const hints = new Set<string>();
  const add = (raw: string, separator: string | RegExp = "/") => {
    const parts = raw
      .split(separator)
      .map((part) => part.trim())
      .filter((part) => part !== "" && part !== "*" && part !== "{" && part !== "}");
    if (parts.length > 0) hints.add(parts.join("/"));
  };
  const dir = posix.dirname(fromPath);
  const quoted = String.raw`["'\`]([^"'\`\n]{1,500})["'\`]`;

  const patterns = [
    // JS/TS, Ruby, PHP: a quoted module path after a keyword.
    new RegExp(
      String.raw`\b(?:from|import|require|require_relative|include|include_once|require_once)[ \t]*(?:\([ \t]*)?${quoted}`,
      "g",
    ),
    new RegExp(String.raw`^[ \t]*#[ \t]*(?:include|import)[ \t]*${quoted}`, "gm"),
  ];
  // A line of a Go import block is a bare quoted path, which in any other
  // language is just a string.
  if (fromPath.endsWith(".go")) {
    patterns.push(new RegExp(String.raw`^[ \t]*(?:[\w.]+[ \t]+)?${quoted}[ \t]*$`, "gm"));
  }
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const spec = match[1] ?? "";
      if (spec.startsWith(".")) {
        const resolved = posix.normalize(posix.join(dir, spec));
        if (!resolved.startsWith("..")) add(resolved.replace(/\.[^/.]+$/, ""));
      } else {
        add(spec.replace(/\.[^/.]+$/, ""));
      }
    }
  }
  // Python.
  for (const match of content.matchAll(
    /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+([\w, \t]+)/gm,
  )) {
    const module = (match[1] ?? "").replace(/^\.+/, "");
    add(module, ".");
    for (const name of (match[2] ?? "").split(",")) add(`${module}.${name.trim()}`, ".");
  }
  for (const match of content.matchAll(/^[ \t]*import[ \t]+([\w.]+)[ \t]*$/gm)) {
    add(match[1] ?? "", ".");
  }
  // Java, Kotlin, Scala, C#.
  for (const match of content.matchAll(
    /^[ \t]*(?:import|using)[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;?[ \t]*$/gm,
  )) {
    add(match[1] ?? "", ".");
  }
  // Rust and PHP.
  for (const match of content.matchAll(/^[ \t]*(?:pub[ \t]+)?use[ \t]+([\w:\\]+)/gm)) {
    add((match[1] ?? "").replace(/^(?:crate|super|self)::/, ""), /::|\\/);
  }
  return [...hints];
}

/** Whether `path` is plausibly the file or package a hint names. */
function matchesHint(path: string, hint: string): boolean {
  const noExt = path.replace(/\.[^/.]+$/, "");
  const dir = posix.dirname(path);
  const tail = hint.split("/").slice(-2).join("/");
  return [noExt, dir].some((candidate) => candidate === tail || candidate.endsWith(`/${tail}`));
}

/** Where a result sits relative to the file asking, best first. */
export function proximityTier(
  match: Pick<SymbolMatch, "path">,
  fromPath: string,
  hints: readonly string[],
): number {
  if (match.path === fromPath) return 0;
  if (posix.dirname(match.path) === posix.dirname(fromPath)) return 1;
  if (hints.some((hint) => matchesHint(match.path, hint))) return 2;
  return 3;
}

/**
 * Orders matches: the asking file (nearest line first), its directory, files
 * it imports, then the rest by path. Stable for equal keys.
 */
export function rankMatches(
  matches: readonly SymbolMatch[],
  from: { path: string; line?: number },
  hints: readonly string[],
): SymbolMatch[] {
  const keyed = matches.map((match) => ({ match, tier: proximityTier(match, from.path, hints) }));
  keyed.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 0 && from.line !== undefined) {
      return Math.abs(a.match.line - from.line) - Math.abs(b.match.line - from.line);
    }
    if (a.match.path !== b.match.path) return a.match.path < b.match.path ? -1 : 1;
    return a.match.line - b.match.line;
  });
  return keyed.map(({ match }) => match);
}

export const MAX_DEFINITIONS = 20;
export const MAX_REFERENCES = 100;
/** Per file, so one generated file can't crowd out the rest. */
export const MAX_MATCHES_PER_FILE = 50;
/** Output read before git is stopped: far more lines than any answer shows. */
export const MAX_GREP_BYTES = 2_000_000;
export const SEARCH_TIMEOUT_MS = 5_000;

/** Runs a git command whose output is capped; {@link ReviewGit.search} in the app. */
export type CappedGitRunner = (
  args: string[],
  opts: { cwd: string; timeoutMs: number; maxBytes: number },
) => Promise<CappedRunResult>;

export interface GrepResult {
  lines: GrepLine[];
  /** Some matches were left out: the output or a file's match cap was reached. */
  truncated: boolean;
  /** The search ran out of time; `lines` is what came before. */
  timedOut: boolean;
}

export class SymbolSearchError extends Error {
  constructor() {
    super("the search failed");
    this.name = "SymbolSearchError";
  }
}

/**
 * Every line at `sha` holding `symbol` as a whole word, in the family's files
 * (all files for no family), less generated code. The symbol is a fixed string
 * (`-F`) passed with `-e`, and the revision is followed by `--`, so nothing in
 * a request is read as an option. Binary files are skipped. Output past the
 * byte cap, or after the timeout, is cut off and reported as truncated.
 * Definitions and references share this one search, so it is what gets cached.
 */
export async function grepSymbol(
  runner: CappedGitRunner,
  clonePath: string,
  sha: string,
  symbol: string,
  family: LanguageFamily | null,
): Promise<GrepResult> {
  if (!isValidSymbol(symbol)) throw new Error("invalid symbol");
  const args = [
    "grep",
    "-I",
    "-n",
    "-z",
    "-w",
    "-F",
    "--no-color",
    "--max-count",
    String(MAX_MATCHES_PER_FILE),
    "-e",
    symbol,
    sha,
    "--",
    ...searchPathspecs(family),
  ];
  const result = await runner(args, {
    cwd: clonePath,
    timeoutMs: SEARCH_TIMEOUT_MS,
    maxBytes: MAX_GREP_BYTES,
  });
  // 1 is git grep's "no match".
  if (result.stopped === null && result.exitCode === 1) {
    return { lines: [], truncated: false, timedOut: false };
  }
  if (result.stopped === null && result.exitCode !== 0) {
    // git's stderr names paths in the clone; it stays in the log.
    console.error(
      `[review-workspaces] git grep failed (${result.exitCode}):`,
      result.stderr.trim(),
    );
    throw new SymbolSearchError();
  }
  const lines = parseGrepOutput(result.stdout, sha);
  const perFile = new Map<string, number>();
  for (const line of lines) perFile.set(line.path, (perFile.get(line.path) ?? 0) + 1);
  const fileCapped = [...perFile.values()].some((count) => count >= MAX_MATCHES_PER_FILE);
  return {
    lines,
    truncated: result.stopped !== null || fileCapped,
    timedOut: result.stopped === "timeout",
  };
}

export interface SymbolQuery {
  symbol: string;
  /** The file asking; ranks results and picks the language. */
  path: string;
  line?: number;
  /** The asking file's content, for its imports. */
  content?: string;
}

export interface SymbolSearchResult {
  matches: SymbolMatch[];
  /** More matched than were returned, or the search was cut short. */
  truncated: boolean;
}

/**
 * The lines of a {@link grepSymbol} result that look like they declare the
 * symbol, ranked; weak candidates follow the strong ones. A file of a language
 * the patterns don't know is read with the generic ones, which are also the
 * second try when a family's own find nothing.
 */
export function pickDefinitions(grep: GrepResult, query: SymbolQuery): SymbolSearchResult {
  const patternsFor = new Map<LanguageFamily | null, DefinitionPatterns>();
  const patterns = (family: LanguageFamily | null) => {
    let found = patternsFor.get(family);
    if (!found) {
      found = definitionPatterns(family, query.symbol);
      patternsFor.set(family, found);
    }
    return found;
  };
  const candidates = grep.lines
    .map((found) => ({ found, text: found.text.slice(0, MAX_LINE_TESTED) }))
    .filter(({ text }) => !COMMENT_LINE.test(text));
  const pick = (which: (found: GrepLine) => RegExp[]) =>
    candidates
      .filter(({ found, text }) => which(found).some((pattern) => pattern.test(text)))
      .map(({ found }) => found);

  let strong = pick((found) => patterns(languageFamilyForPath(found.path)).strong);
  const weak = pick((found) => patterns(languageFamilyForPath(found.path)).weak);
  // A family's patterns can miss a dialect (a Kotlin `typealias`, a Go
  // generic); the generic ones are the second try before giving up.
  if (strong.length === 0 && weak.length === 0) strong = pick(() => patterns(null).strong);

  const hints = query.content ? importHints(query.path, query.content) : [];
  const from = { path: query.path, line: query.line };
  const strongIn = new Set(strong);
  const ranked = [
    ...rankMatches(toMatches(strong, query.symbol), from, hints),
    ...rankMatches(
      toMatches(
        weak.filter((found) => !strongIn.has(found)),
        query.symbol,
      ),
      from,
      hints,
    ),
  ];
  return {
    matches: ranked.slice(0, MAX_DEFINITIONS),
    truncated: grep.truncated || ranked.length > MAX_DEFINITIONS,
  };
}

/** Every whole-word use in a {@link grepSymbol} result, ranked. */
export function pickReferences(grep: GrepResult, query: SymbolQuery): SymbolSearchResult {
  const hints = query.content ? importHints(query.path, query.content) : [];
  const ranked = rankMatches(
    toMatches(grep.lines, query.symbol),
    { path: query.path, line: query.line },
    hints,
  );
  return {
    matches: ranked.slice(0, MAX_REFERENCES),
    truncated: grep.truncated || ranked.length > MAX_REFERENCES,
  };
}
