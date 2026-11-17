/**
 * Tripwires: changes that are how malicious code usually gets in, found by
 * fixed rules over the diff rather than by a model. The malicious-intent check
 * is given them to judge, and the report shows them whatever it decides, so a
 * persuasive PR can't talk them away.
 *
 * Each rule is about where something hides, not about whether it is bad:
 * almost every PR that touches CI or adds a binary is fine. That is the
 * check's call, with the evidence in front of it.
 */

import { spotlight } from "../agentRuns/service.ts";
import { hasInvisibleChars } from "../web/extract.ts";
import type { PatchSource } from "./patchFiles.ts";

/** Most telling first: the order the list is cut in when it is over {@link MAX_TRIPWIRES}. */
export const TRIPWIRE_KINDS = [
  "hidden-text",
  "opaque-blob",
  "test-tampering",
  "build",
  "binary",
] as const;
export type TripwireKind = (typeof TRIPWIRE_KINDS)[number];

export interface Tripwire {
  kind: TripwireKind;
  path: string;
  /** The head line, for a rule that matched one line. */
  line?: number;
  note: string;
}

/** Past this many the list stops helping; the check is told how many were left out. */
export const MAX_TRIPWIRES = 40;

/** Files that decide what runs at build, install, test, CI or review time, and why each matters. */
const SENSITIVE_PATHS: { test: RegExp; note: string }[] = [
  {
    test: /^\.github\/(workflows|actions)\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.ya?ml|Jenkinsfile)$|^\.circleci\//,
    note: "CI configuration: runs with the repo's secrets and write access",
  },
  {
    test: /(^|\/)(Makefile|GNUmakefile|CMakeLists\.txt|configure(\.ac)?|build\.rs|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|gradlew|mvnw|setup\.py|conftest\.py)$|\.(mk|m4)$|(^|\/)(gradle|\.mvn)\/wrapper\//,
    note: "build or test script: runs on every machine that builds or tests the code",
  },
  {
    test: /(^|\/)(jest|vitest|vite|webpack|rollup|babel|playwright)\.config\.[cm]?[jt]s$|(^|\/)(bunfig\.toml|\.npmrc|\.yarnrc(\.yml)?|\.cargo\/config(\.toml)?)$/,
    note: "tool configuration: can load and run code whenever the tests or build run",
  },
  {
    test: /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$|(^|\/)\.devcontainer\//,
    note: "container build: decides what ships in the image or runs in the dev container",
  },
  {
    test: /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|Gemfile|go\.mod|requirements[^/]*\.txt)$/,
    note: "package manifest: install scripts and dependencies run on install",
  },
  {
    test: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|go\.sum)$/,
    note: "lockfile: decides exactly which package, from where, gets installed",
  },
  {
    test: /(^|\/)(\.claude|\.cursor|\.gemini|\.vscode)\/|(^|\/)(\.mcp\.json|CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.cursorrules|\.windsurfrules|copilot-instructions\.md)$/,
    note: "editor or coding-agent configuration: instructions, tasks and tools for everyone who opens the repo",
  },
  {
    test: /(^|\/)(CODEOWNERS|lefthook\.ya?ml|\.pre-commit-config\.yaml|\.gitattributes|\.gitmodules|\.envrc|mise\.toml|\.tool-versions)$|(^|\/)\.husky\//,
    note: "hooks, ownership or environment: decides what runs on checkout or commit, or who must approve",
  },
];

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$|_(test|spec)\.(go|py|rs|rb)$|(^|\/)test_[^/]*\.py$|Tests?\.(java|kt|cs)$/;
const SNAPSHOT_DIR = /(^|\/)__snapshots__\//;

function isSnapshot(path: string): boolean {
  return SNAPSHOT_DIR.test(path) || path.endsWith(".snap");
}
/** A minified file the PR adds is only skimmed by the agents, so it is a place to hide. */
const MINIFIED_PATH = /\.min\.(js|mjs|cjs|css)$/;

/**
 * Invisible characters the app already screens web pages for, plus the
 * variation selectors and Hangul fillers that make an identifier invisible in
 * code (`const { a, ㅤ } = req.query`).
 */
const INVISIBLE_IN_CODE = /[\u{FE00}-\u{FE0F}\u{115F}\u{1160}\u{3164}\u{FFA0}]/u;

function hasHiddenText(text: string): boolean {
  return hasInvisibleChars(text) || INVISIBLE_IN_CODE.test(text);
}

/** Each long unbroken run of base64 or hex, whole: a payload a reader can't read. */
const OPAQUE_BLOB = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{200,}/g;
/** Fewer distinct characters than this is filler (a ruler, padding), not encoded data. */
const OPAQUE_MIN_DISTINCT = 12;

function hasOpaqueBlob(text: string): boolean {
  for (const match of text.matchAll(OPAQUE_BLOB)) {
    if (new Set(match[0]).size >= OPAQUE_MIN_DISTINCT) return true;
  }
  return false;
}

const SKIP_MARKER =
  /\.(skip|only|todo|skipIf|runIf)\b|\b(xit|xdescribe|xtest|fit|fdescribe)\(|@pytest\.mark\.(skip|xfail)|\bpytest\.skip\(|@unittest\.skip|@(Disabled|Ignore)\b|\bt\.Skip\(|#\[ignore\]/;
const ASSERTION = /\b(expect|assert\w*)\s*[.(!]/;

const HUNK_HEAD = /^@@ -\d+(?:,\d+)? \+(\d+)/;

/** Why a changed path is a tripwire, or null. */
export function sensitivePath(path: string): string | null {
  return SENSITIVE_PATHS.find((p) => p.test.test(path))?.note ?? null;
}

/**
 * The tripwires in one file's patch: hidden text and opaque blobs on added
 * lines, and in a test file, added skip markers and assertions taken out.
 * `bulk` files (lockfiles, minified code) get the hidden-text rule only, since
 * their content is unreadable by design.
 */
export function scanPatch(path: string, patch: string, bulk = false): Tripwire[] {
  const found: Tripwire[] = [];
  const isTest = !bulk && TEST_PATH.test(path);
  let head = 0;
  let removedAssertions = 0;
  let addedAssertions = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEAD.exec(line);
    if (hunk) {
      head = Number(hunk[1]);
      continue;
    }
    if (head === 0) continue;
    if (line.startsWith("+")) {
      const text = line.slice(1);
      if (hasHiddenText(text)) {
        found.push({
          kind: "hidden-text",
          path,
          line: head,
          note: "invisible or direction-changing characters",
        });
      }
      if (!bulk && hasOpaqueBlob(text)) {
        found.push({ kind: "opaque-blob", path, line: head, note: "long encoded string" });
      }
      if (isTest && SKIP_MARKER.test(text)) {
        found.push({ kind: "test-tampering", path, line: head, note: "test skipped or focused" });
      }
      if (isTest && ASSERTION.test(text)) addedAssertions++;
      head++;
    } else if (line.startsWith("-")) {
      if (isTest && ASSERTION.test(line.slice(1))) removedAssertions++;
    } else if (line.startsWith(" ")) {
      head++;
    }
  }
  if (removedAssertions > addedAssertions) {
    found.push({
      kind: "test-tampering",
      path,
      note: `${removedAssertions} assertions removed, ${addedAssertions} added`,
    });
  }
  return found;
}

/** The tripwires a changed file's paths set off, before its patch is read. */
function pathTripwires(source: PatchSource): Tripwire[] {
  const { path, oldPath, status } = source;
  const found: Tripwire[] = [];
  if (hasHiddenText(path)) {
    found.push({ kind: "hidden-text", path, note: "invisible characters in the file's name" });
  }
  const sensitive = sensitivePath(path);
  if (status === "deleted") {
    // Taking out a security workflow, an owner rule or a test is a way in too.
    if (sensitive) found.push({ kind: "build", path, note: `removed ${sensitive}` });
    if (TEST_PATH.test(path) || isSnapshot(path)) {
      found.push({ kind: "test-tampering", path, note: "test file deleted" });
    }
    return found;
  }
  if (sensitive) found.push({ kind: "build", path, note: sensitive });
  // A rename out of a sensitive or test location has the effect of a deletion.
  if (oldPath && oldPath !== path) {
    const was = sensitivePath(oldPath);
    if (was && was !== sensitive) {
      found.push({ kind: "build", path, note: `moved from ${oldPath}: ${was}` });
    }
    if (TEST_PATH.test(oldPath) && !TEST_PATH.test(path)) {
      found.push({ kind: "test-tampering", path, note: `moved out of the tests from ${oldPath}` });
    }
  }
  if (source.binary) found.push({ kind: "binary", path, note: "binary file: no diff to review" });
  if (isSnapshot(path)) {
    found.push({ kind: "test-tampering", path, note: "snapshot changed" });
  }
  if (status === "added" && MINIFIED_PATH.test(path)) {
    found.push({ kind: "opaque-blob", path, note: "minified file added: the agents only skim it" });
  }
  return found;
}

/**
 * Collects a PR's tripwires while its patches are written: pass `onPatch` to
 * `writePatchFiles`, then read `result()`.
 */
export function tripwireCollector(sources: PatchSource[]) {
  const found: Tripwire[] = sources.flatMap(pathTripwires);
  return {
    onPatch(source: PatchSource, patch: string) {
      if (source.status !== "deleted") {
        found.push(...scanPatch(source.path, patch, Boolean(source.skim)));
      }
    },
    /** The most telling first, so a PR can't bury a hidden-text hit under forty binaries. */
    result(): { tripwires: Tripwire[]; omitted: number } {
      const rank = (t: Tripwire) => TRIPWIRE_KINDS.indexOf(t.kind);
      // Array.prototype.sort is stable, so each kind keeps the diff's file order.
      const sorted = [...found].sort((a, b) => rank(a) - rank(b));
      return {
        tripwires: sorted.slice(0, MAX_TRIPWIRES),
        omitted: Math.max(0, found.length - MAX_TRIPWIRES),
      };
    },
  };
}

/** An entry on one line, so a path with a line break in it can't pose as another entry. */
const oneLine = (path: string) => path.replace(/\r/g, "\\r").replace(/\n/g, "\\n");

/** tripwires.md for the malicious-intent check. Paths are the PR author's, so the list is fenced. */
export function tripwiresFile({ tripwires, omitted }: { tripwires: Tripwire[]; omitted: number }) {
  const lines = tripwires.map((t) =>
    oneLine(`- [${t.kind}] ${t.path}${t.line ? `:${t.line}` : ""}: ${t.note}`),
  );
  return [
    "# Tripwires",
    "Yarvis's fixed rules found these in the diff, most telling first. Each is a place " +
      "malicious changes often hide, not proof of one. The notes are Yarvis's; the paths " +
      "between the fence tags are the PR author's.",
    spotlight("tripwires", lines.join("\n") || "(none)"),
    omitted ? `${omitted} more were left out.` : null,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n\n");
}
