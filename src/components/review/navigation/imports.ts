/**
 * Resolves a TypeScript or JavaScript file's imports to paths in the PR's head
 * tree, the way the TypeScript compiler would with the repo's own tsconfig:
 * relative paths, `paths` and `baseUrl`, index files and extensions. The
 * tsconfig is read as data (JSON with comments); nothing from the repo runs.
 * Packages are not resolved: a committed `node_modules` holds ambient
 * declarations that would reach every PR sharing the TypeScript worker.
 */

export const posix = {
  dirname(path: string): string {
    const at = path.lastIndexOf("/");
    return at < 0 ? "" : path.slice(0, at);
  },
  /** Joins and normalizes; null when the result climbs out of the repo. */
  join(...parts: string[]): string | null {
    const out: string[] = [];
    for (const segment of parts.join("/").split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (out.length === 0) return null;
        out.pop();
      } else {
        out.push(segment);
      }
    }
    return out.join("/");
  },
};

/** Extensions the TypeScript worker reads, in the order the compiler tries them. */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];

export function isTsJsPath(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path);
}

/** Imports sit at the top of a file; reading further only costs time. */
const MAX_SCANNED = 256 * 1024;
/** A file naming more modules than this is generated; the rest are skipped. */
export const MAX_SPECIFIERS = 500;

/**
 * The module specifiers a file names: static and dynamic imports, re-exports,
 * `require`, and `/// <reference path>`. Read with patterns rather than a
 * parser, so a specifier in a comment is picked up too; it only costs a
 * lookup that finds nothing or a file nobody jumps to. A multi-line import is
 * found by its `from` clause, so no pattern spans lines, which keeps each one
 * linear on any input.
 */
export function importSpecifiers(fullContent: string): string[] {
  const content = fullContent.slice(0, MAX_SCANNED);
  const found = new Set<string>();
  const quoted = String.raw`(['"])([^'"\n]{1,500})\1`;
  const patterns = [
    new RegExp(String.raw`\bfrom[ \t]*${quoted}`, "g"),
    new RegExp(String.raw`\bimport[ \t]*${quoted}`, "g"),
    new RegExp(String.raw`\b(?:import|require)[ \t]*\([ \t]*${quoted}[ \t]*\)`, "g"),
    new RegExp(String.raw`///[ \t]*<reference[ \t]+path[ \t]*=[ \t]*${quoted}`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const spec = match[2]?.trim();
      if (spec) found.add(spec);
      if (found.size >= MAX_SPECIFIERS) return [...found];
    }
  }
  return [...found];
}

/** What of a tsconfig changes how imports resolve, with every path made repo-relative. */
export interface TsPathConfig {
  /** The folder of the config that governs the file (`""` for the root). */
  dir: string;
  /** Repo path `baseUrl` points at, when set. */
  baseUrl?: string;
  /** Alias patterns (`@/*`) to repo-path targets (`src/*`). */
  paths: Record<string, string[]>;
}

/**
 * Parses JSON with comments and trailing commas, as tsconfig allows. Null for
 * anything that still isn't JSON.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      // Copy a string whole, so a `//` inside one survives.
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

type ReadFile = (path: string) => Promise<string | null>;

interface RawConfig {
  extends?: unknown;
  references?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

type ConfigOptions = Omit<TsPathConfig, "dir">;

const CONFIG_NAMES = ["tsconfig.json", "jsconfig.json"];
/** `extends` chains and solution-style `references` followed before giving up. */
const MAX_CONFIG_HOPS = 4;

/**
 * The tsconfig (or jsconfig) that governs `path`: the nearest one up the
 * tree, with a relative `extends` chain applied. A solution-style config that
 * only lists `references` stands for the first referenced config that sets
 * `paths` or `baseUrl`. Package-name `extends` (a config in `node_modules`)
 * isn't followed.
 */
export async function loadTsPathConfig(
  path: string,
  tree: ReadonlySet<string>,
  readFile: ReadFile,
): Promise<TsPathConfig | null> {
  let dir = posix.dirname(path);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = dir ? `${dir}/${name}` : name;
      if (tree.has(candidate)) {
        const options = await readConfig(candidate, tree, readFile, MAX_CONFIG_HOPS);
        return options && { dir, ...options };
      }
    }
    if (dir === "") return null;
    dir = posix.dirname(dir);
  }
}

async function readConfig(
  configPath: string,
  tree: ReadonlySet<string>,
  readFile: ReadFile,
  hops: number,
): Promise<ConfigOptions | null> {
  const text = await readFile(configPath);
  const raw = text === null ? null : (parseJsonc(text) as RawConfig | null);
  if (!raw || typeof raw !== "object") return null;
  const dir = posix.dirname(configPath);

  let inherited: ConfigOptions | null = null;
  if (hops > 0 && typeof raw.extends === "string" && raw.extends.startsWith(".")) {
    const parent = posix.join(dir, raw.extends);
    const parentPath = parent && !parent.endsWith(".json") ? `${parent}.json` : parent;
    if (parentPath && tree.has(parentPath)) {
      inherited = await readConfig(parentPath, tree, readFile, hops - 1);
    }
  }

  const options = raw.compilerOptions ?? {};
  const baseUrl =
    typeof options.baseUrl === "string"
      ? (posix.join(dir, options.baseUrl) ?? undefined)
      : inherited?.baseUrl;
  let paths = inherited?.paths ?? {};
  if (options.paths && typeof options.paths === "object") {
    // Targets are relative to `baseUrl` when there is one, else to the config
    // that declares them.
    const root = baseUrl ?? dir;
    paths = {};
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      // The compiler rejects a pattern or target with more than one `*`.
      if (!Array.isArray(targets) || starCount(pattern) > 1) continue;
      const resolved = targets
        .filter((t): t is string => typeof t === "string" && starCount(t) <= 1)
        .map((t) => posix.join(root, t))
        .filter((t): t is string => t !== null);
      if (resolved.length > 0) paths[pattern] = resolved;
    }
  }

  if (baseUrl === undefined && Object.keys(paths).length === 0 && hops > 0) {
    for (const reference of Array.isArray(raw.references) ? raw.references : []) {
      const refPath = (reference as { path?: unknown })?.path;
      if (typeof refPath !== "string") continue;
      const target = posix.join(dir, refPath);
      if (target === null) continue;
      const file = target.endsWith(".json") ? target : `${target}/tsconfig.json`;
      if (!tree.has(file)) continue;
      const referenced = await readConfig(file, tree, readFile, hops - 1);
      if (
        referenced &&
        (referenced.baseUrl !== undefined || Object.keys(referenced.paths).length)
      ) {
        return referenced;
      }
    }
  }
  return { ...(baseUrl !== undefined ? { baseUrl } : {}), paths };
}

/** The file `base` names, trying extensions and an index file as the compiler does. */
function tryFile(base: string, tree: ReadonlySet<string>): string | null {
  if (tree.has(base) && SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext))) return base;
  // An ESM import names the emitted `.js`; the source beside it is `.ts`.
  const jsStem = /\.([cm]?)jsx?$/.exec(base);
  if (jsStem) {
    const stem = base.slice(0, jsStem.index);
    const flavour = jsStem[1] ?? "";
    for (const ext of [`.${flavour}ts`, ".tsx", `.d.${flavour}ts`]) {
      if (tree.has(stem + ext)) return stem + ext;
    }
  }
  for (const ext of SOURCE_EXTENSIONS) {
    if (tree.has(base + ext)) return base + ext;
  }
  for (const ext of SOURCE_EXTENSIONS) {
    const index = base ? `${base}/index${ext}` : `index${ext}`;
    if (tree.has(index)) return index;
  }
  return null;
}

function starCount(text: string): number {
  return text.split("*").length - 1;
}

/** Matches `spec` against a `paths` pattern; the text `*` stood for, or null. */
function matchPattern(pattern: string, spec: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === spec ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (spec.length < prefix.length + suffix.length) return null;
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) return null;
  return spec.slice(prefix.length, spec.length - suffix.length);
}

/** An exact pattern counts as all prefix, so it outranks every wildcard. */
function prefixLength(pattern: string): number {
  const star = pattern.indexOf("*");
  return star < 0 ? pattern.length : star;
}

export const isRelativeSpecifier = (spec: string) =>
  spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");

/**
 * The head-tree path `spec` resolves to from `fromPath`, or null. Order
 * follows the compiler: relative paths; then `paths`, the pattern with the
 * longest prefix first, each target in turn; then `baseUrl`. A package name
 * that neither maps resolves to nothing.
 */
export function resolveSpecifier(
  spec: string,
  fromPath: string,
  tree: ReadonlySet<string>,
  config: TsPathConfig | null,
): string | null {
  if (isRelativeSpecifier(spec)) {
    const base = posix.join(posix.dirname(fromPath), spec);
    return base === null ? null : tryFile(base, tree);
  }
  if (spec.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(spec) || !config) return null;

  const patterns = Object.keys(config.paths)
    .map((pattern) => ({ pattern, rest: matchPattern(pattern, spec) }))
    .filter((p): p is { pattern: string; rest: string } => p.rest !== null)
    .sort((a, b) => prefixLength(b.pattern) - prefixLength(a.pattern));
  for (const { pattern, rest } of patterns) {
    for (const target of config.paths[pattern] ?? []) {
      const found = tryFile(target.split("*").join(rest), tree);
      if (found) return found;
    }
  }
  if (config.baseUrl !== undefined) {
    const base = posix.join(config.baseUrl, spec);
    const found = base === null ? null : tryFile(base, tree);
    if (found) return found;
  }
  return null;
}
