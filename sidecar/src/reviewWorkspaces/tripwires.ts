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
import type { PatchSource } from "./patchFiles.ts";

export const TRIPWIRE_KINDS = [
  "build",
  "binary",
  "hidden-text",
  "opaque-blob",
  "test-tampering",
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

/** Files that decide what runs at build, install, CI or review time, and why each matters. */
const SENSITIVE_PATHS: { test: RegExp; note: string }[] = [
  {
    test: /^\.github\/(workflows|actions)\/|(^|\/)(\.gitlab-ci\.yml|azure-pipelines\.ya?ml|Jenkinsfile)$|^\.circleci\//,
    note: "CI configuration: runs with the repo's secrets and write access",
  },
  {
    test: /(^|\/)(Makefile|GNUmakefile|CMakeLists\.txt|configure(\.ac)?|build\.rs|build\.gradle(\.kts)?|setup\.py)$|\.(mk|m4)$/,
    note: "build script: runs on every machine that builds the code",
  },
  {
    test: /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/,
    note: "container build: decides what ships in the image",
  },
  {
    test: /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|Gemfile|go\.mod|requirements[^/]*\.txt)$/,
    note: "package manifest: install scripts and dependencies run on install",
  },
  {
    test: /(^|\/)(\.claude|\.cursor)\/|(^|\/)(\.mcp\.json|CLAUDE\.md|AGENTS\.md)$/,
    note: "coding-agent configuration: instructions and tools for every agent session in the repo",
  },
  {
    test: /(^|\/)(CODEOWNERS|lefthook\.ya?ml|\.pre-commit-config\.yaml)$|(^|\/)\.husky\//,
    note: "hooks or ownership: decides what runs on commit or who must approve",
  },
];

const TEST_PATH =
  /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const SNAPSHOT_PATH = /(^|\/)__snapshots__\/|\.snap$/;

/** Bidi controls (Trojan Source) and zero-width characters: text that reads differently than it runs. */
const HIDDEN_TEXT = /[​-‍⁠‪-‮⁦-⁩﻿]/;
/** A long unbroken run of base64 or hex: a payload a reader can't read. */
const OPAQUE_BLOB = /[A-Za-z0-9+/=_-]{200,}/;
/** Fewer distinct characters than this is filler (a ruler, padding), not encoded data. */
const OPAQUE_MIN_DISTINCT = 12;

function hasOpaqueBlob(text: string): boolean {
  const match = OPAQUE_BLOB.exec(text);
  return match !== null && new Set(match[0]).size >= OPAQUE_MIN_DISTINCT;
}
const SKIP_MARKER =
  /\.(skip|only)\(|\b(xit|xdescribe|xtest|fit|fdescribe)\(|@pytest\.mark\.(skip|xfail)|@(Disabled|Ignore)\b|\bt\.Skip\(/;
const ASSERTION = /\b(expect|assert\w*)\s*[.(!]/;

const HUNK_HEAD = /^@@ -\d+(?:,\d+)? \+(\d+)/;

/** Why a changed path is a tripwire, or null. */
export function sensitivePath(path: string): string | null {
  return SENSITIVE_PATHS.find((p) => p.test.test(path))?.note ?? null;
}

/**
 * The tripwires in one file's patch: hidden text and opaque blobs on added
 * lines, and in a test file, added skip markers and assertions taken out.
 */
export function scanPatch(path: string, patch: string): Tripwire[] {
  const found: Tripwire[] = [];
  const isTest = TEST_PATH.test(path);
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
      if (HIDDEN_TEXT.test(text)) {
        found.push({
          kind: "hidden-text",
          path,
          line: head,
          note: "invisible or direction-changing characters",
        });
      }
      if (hasOpaqueBlob(text)) {
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

/**
 * Collects a PR's tripwires while its patches are written: pass `onPatch` to
 * `writePatchFiles`, then read `result()`. Bulk files (lockfiles, minified or
 * generated code) are checked by path only, since their content is meant to
 * be unreadable.
 */
export function tripwireCollector(sources: PatchSource[]) {
  const found: Tripwire[] = [];
  for (const source of sources) {
    if (source.status === "deleted") continue;
    const sensitive = sensitivePath(source.path);
    if (sensitive) found.push({ kind: "build", path: source.path, note: sensitive });
    if (source.binary) {
      found.push({ kind: "binary", path: source.path, note: "binary file: no diff to review" });
    }
    if (SNAPSHOT_PATH.test(source.path)) {
      found.push({ kind: "test-tampering", path: source.path, note: "snapshot changed" });
    }
  }
  return {
    onPatch(source: PatchSource, patch: string) {
      if (source.status !== "deleted" && !source.skim) found.push(...scanPatch(source.path, patch));
    },
    result(): { tripwires: Tripwire[]; omitted: number } {
      return {
        tripwires: found.slice(0, MAX_TRIPWIRES),
        omitted: Math.max(0, found.length - MAX_TRIPWIRES),
      };
    },
  };
}

/** tripwires.md for the malicious-intent check. Paths are the PR author's, so the list is fenced. */
export function tripwiresFile({ tripwires, omitted }: { tripwires: Tripwire[]; omitted: number }) {
  const lines = tripwires.map(
    (t) => `- [${t.kind}] ${t.path}${t.line ? `:${t.line}` : ""}: ${t.note}`,
  );
  return [
    "# Tripwires",
    "Yarvis's fixed rules found these in the diff. Each is a place malicious changes often " +
      "hide, not proof of one. Judge every one.",
    spotlight("tripwires", lines.join("\n") || "(none)"),
    omitted ? `${omitted} more were left out.` : null,
    "",
  ]
    .filter((l) => l !== null)
    .join("\n\n");
}
