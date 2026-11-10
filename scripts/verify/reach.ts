/**
 * How much of the codebase depends on each changed TypeScript file, from the
 * import graph at the PR's head. The `/verify-pr` skill uses it to rate each
 * change's reach (`sidecar/src/verify/impact.ts`). It reads files and runs
 * nothing, so it is safe on a PR whose code isn't trusted.
 *
 * It counts a file's importers, not a symbol's: a file many modules import can
 * still hold a private helper only it uses, so the count is an upper bound
 * for any one change in it.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Reach } from "../../sidecar/src/verify/impact.ts";
import { isTestFile } from "./tier.ts";

export interface FileReach {
  path: string;
  /** Non-test files that import it. */
  importers: number;
  /** Feature areas those importers sit in, other than the file's own. */
  otherAreas: number;
  /** The reach the counts suggest; the skill may rate a change in the file lower. */
  suggested: Reach;
}

/**
 * Source roots and how many directory levels below each make a feature area.
 * The frontend nests one level deeper (`src/components/review`) than the
 * sidecar (`sidecar/src/chat`).
 */
const AREA_DEPTH: [root: string, depth: number][] = [
  ["sidecar/src/", 1],
  ["src/", 2],
  ["scripts/", 1],
  ["demo/", 1],
];

const SOURCE = /\.(ts|tsx)$/;

/** The feature area a file belongs to, or `null` outside the source roots. */
export function areaOf(path: string): string | null {
  const entry = AREA_DEPTH.find(([root]) => path.startsWith(root));
  if (!entry) return null;
  const [root, depth] = entry;
  const dirs = path.slice(root.length).split("/").slice(0, -1);
  return root + dirs.slice(0, depth).join("/");
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/** The repo paths a file imports, resolved against the files that exist. */
export function importsOf(path: string, text: string, files: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(IMPORT)) {
    const spec = match[1];
    if (!spec.startsWith(".")) continue;
    const base = normalize(join(dirname(path), spec));
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    const hit = candidates.find((c) => files.has(c));
    if (hit) found.add(hit);
  }
  return [...found];
}

/**
 * Set from the repo's own graph, where these rate about 5% of source files
 * core and 20% shared. The modules everything goes through (`db/client.ts`,
 * `config.ts`, `lib/fencing.ts`, `chat/agent.ts`) are imported from five or
 * more other areas; most others from one or none.
 */
const SHARED_AREAS = 2;
const CORE_AREAS = 5;

function suggest(importers: number, otherAreas: number): Reach {
  if (importers === 0) return "leaf";
  if (otherAreas >= CORE_AREAS) return "core";
  if (otherAreas >= SHARED_AREAS) return "shared";
  return "local";
}

/**
 * The reach of each changed source file. `files` is every tracked file at the
 * head and `read` returns one's text; both are parameters so tests need no repo.
 */
export function measureReach(
  changed: readonly string[],
  files: readonly string[],
  read: (path: string) => string | null,
): FileReach[] {
  const sources = files.filter((f) => SOURCE.test(f) && areaOf(f) !== null);
  const known = new Set(sources);
  const importersOf = new Map<string, Set<string>>();
  for (const file of sources) {
    if (isTestFile(file)) continue;
    const text = read(file);
    if (text === null) continue;
    for (const target of importsOf(file, text, known)) {
      if (target === file) continue;
      const set = importersOf.get(target) ?? new Set();
      set.add(file);
      importersOf.set(target, set);
    }
  }
  return changed
    .filter((path) => known.has(path) && !isTestFile(path))
    .map((path) => {
      const importers = [...(importersOf.get(path) ?? [])];
      const own = areaOf(path);
      const otherAreas = new Set(importers.map(areaOf).filter((a) => a !== own)).size;
      return {
        path,
        importers: importers.length,
        otherAreas,
        suggested: suggest(importers.length, otherAreas),
      };
    });
}

/** Reads a file under `root`, or `null` when it is gone or unreadable. */
export function fileReader(root: string): (path: string) => string | null {
  return (path) => {
    const full = join(root, path);
    try {
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    } catch {
      return null;
    }
  };
}
