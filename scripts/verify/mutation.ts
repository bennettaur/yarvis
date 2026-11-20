/**
 * Mutation testing on the lines a pull request changed. Stryker makes small
 * breaking edits to those lines (flips a comparison, drops a branch) and runs
 * the related tests against each one. An edit no test notices is a line the
 * tests run but don't check, which coverage alone can't tell apart from a
 * tested one.
 *
 * Opt-in through `collect.ts --mutation`, since each mutant is a test run.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddedLines, LineHits } from "./diffCoverage.ts";
import { run } from "./exec.ts";
import { isTestFile } from "./tier.ts";

export interface MutationResult {
  /** Killed or timed-out mutants over all that ran, or `null` if none ran. */
  score: number | null;
  killed: number;
  /** Mutants no test noticed, as `path:line description`. */
  survived: string[];
  /** Changed ranges left unmutated to bound the run time. */
  skippedRanges: number;
}

/** Past this many ranges a run takes longer than the review it feeds. */
const MAX_RANGES = 40;

/** The suites `bun test` runs separately, each from its own directory with its own bunfig. */
export type Suite = "frontend" | "sidecar";

export function suiteOf(path: string): Suite {
  return path.startsWith("sidecar/") ? "sidecar" : "frontend";
}

/**
 * Stryker `mutate` entries (`path:start-end`) covering one suite's changed
 * lines that a test ran. Lines no test ran are already reported by diff
 * coverage, and every mutant on them would survive, so they are left out.
 */
export function mutationTargets(
  added: AddedLines,
  hits: LineHits,
  suite: Suite,
): { targets: string[]; skipped: number } {
  const targets: string[] = [];
  for (const [path, lines] of added) {
    if (!/\.tsx?$/.test(path) || isTestFile(path) || path.endsWith(".d.ts")) continue;
    if (suiteOf(path) !== suite) continue;
    const fileHits = hits.get(path);
    if (!fileHits) continue;
    const covered = [...lines]
      .filter((line) => (fileHits.get(line) ?? 0) > 0)
      .sort((a, b) => a - b);
    if (covered.length === 0) continue;

    let start = covered[0];
    let previous = start;
    for (const line of covered.slice(1)) {
      if (line === previous + 1) {
        previous = line;
        continue;
      }
      targets.push(`${path}:${start}-${previous}`);
      start = line;
      previous = line;
    }
    targets.push(`${path}:${start}-${previous}`);
  }
  return {
    targets: targets.slice(0, MAX_RANGES),
    skipped: Math.max(0, targets.length - MAX_RANGES),
  };
}

/**
 * The tests to run against each mutant, repo-relative: the PR's own changed
 * tests in this suite, plus each mutated file's sibling `*.test.ts(x)`, which
 * is how this repo pairs code and tests.
 */
export function relatedTests(
  root: string,
  suite: Suite,
  targets: string[],
  changedTests: string[],
): string[] {
  const tests = new Set(changedTests.filter((path) => suiteOf(path) === suite));
  for (const target of targets) {
    const file = target.slice(0, target.lastIndexOf(":"));
    for (const sibling of [
      file.replace(/\.tsx?$/, ".test.ts"),
      file.replace(/\.tsx?$/, ".test.tsx"),
    ]) {
      if (existsSync(join(root, sibling))) tests.add(sibling);
    }
  }
  return [...tests].sort();
}

/**
 * Stryker's command runner hands this to a shell. Every part is a path from
 * git or the bun binary's own path, but quoting keeps a stray space or `;` in
 * a file name from being read as shell syntax.
 */
export function testCommand(bun: string, suite: Suite, tests: string[]): string {
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  const relative = tests.map((test) =>
    quote(`./${suite === "sidecar" ? test.slice("sidecar/".length) : test}`),
  );
  const command = `${quote(bun)} test ${relative.join(" ")}`;
  // The sidecar suite runs from sidecar/ so its own bunfig preload applies.
  return suite === "sidecar" ? `cd sidecar && ${command}` : command;
}

interface StrykerReport {
  files: Record<
    string,
    {
      mutants: {
        status: string;
        mutatorName: string;
        replacement?: string;
        location: { start: { line: number } };
      }[];
    }
  >;
}

/** Statuses that say nothing about the tests: the mutant didn't compile, crashed, or never ran. */
const UNSCORED_STATUSES = new Set(["CompileError", "RuntimeError", "Ignored", "Pending"]);

export function readStrykerReport(report: StrykerReport): Omit<MutationResult, "skippedRanges"> {
  let killed = 0;
  let total = 0;
  const survived: string[] = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (UNSCORED_STATUSES.has(mutant.status)) continue;
      total++;
      if (mutant.status === "Killed" || mutant.status === "Timeout") {
        killed++;
      } else {
        const change = mutant.replacement ? ` → ${mutant.replacement.split("\n")[0]}` : "";
        survived.push(`${file}:${mutant.location.start.line} ${mutant.mutatorName}${change}`);
      }
    }
  }
  return { score: total > 0 ? killed / total : null, killed, survived };
}

export function mergeMutation(results: MutationResult[]): MutationResult {
  const killed = results.reduce((sum, r) => sum + r.killed, 0);
  const survived = results.flatMap((r) => r.survived);
  const total = killed + survived.length;
  return {
    score: total > 0 ? killed / total : null,
    killed,
    survived,
    skippedRanges: results.reduce((sum, r) => sum + r.skippedRanges, 0),
  };
}

/** Large or generated directories a mutant can't affect, kept out of Stryker's sandbox copy. */
const SANDBOX_IGNORE = [
  "src-tauri/target",
  "src-tauri/gen",
  "video/node_modules",
  "demo/output",
  "dist",
  "coverage",
];

/**
 * Runs Stryker for one suite. Returns `null` when there was nothing to mutate
 * or no test to run, and also when Stryker fails, so a broken mutation run
 * leaves the rest of the facts intact.
 */
export function runMutation(input: {
  root: string;
  suite: Suite;
  out: string;
  added: AddedLines;
  hits: LineHits;
  changedTests: string[];
}): MutationResult | null {
  const { root, suite, out } = input;
  const { targets, skipped } = mutationTargets(input.added, input.hits, suite);
  const tests = relatedTests(root, suite, targets, input.changedTests);
  if (targets.length === 0 || tests.length === 0) return null;

  const reportPath = join(out, `mutation-${suite}.json`);
  const config = join(out, `stryker-${suite}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      testRunner: "command",
      // `process.execPath` is the bun running this script, so mutants run on the same one.
      commandRunner: { command: testCommand(process.execPath, suite, tests) },
      mutate: targets,
      coverageAnalysis: "off",
      // Sidecar tests share one test database and TRUNCATE between tests, so
      // mutants running side by side would fail each other's tests.
      ...(suite === "sidecar" ? { concurrency: 1 } : {}),
      // Stryker rewrites tsconfig references with an API TypeScript 7 dropped.
      // Bun doesn't read them, so a name that doesn't exist skips the rewrite.
      tsconfigFile: "no-tsconfig-for-stryker.json",
      ignorePatterns: SANDBOX_IGNORE,
      reporters: ["json"],
      jsonReporter: { fileName: reportPath },
      tempDirName: join(out, `stryker-tmp-${suite}`),
      cleanTempDir: "always",
    }),
  );
  // Always from the repo root, so the sandbox holds the hoisted node_modules
  // both suites resolve from.
  const result = run(join(root, "node_modules/.bin/stryker"), ["run", config], {
    cwd: root,
    allowFailure: true,
  });
  if (result.status !== 0 || !existsSync(reportPath)) {
    console.warn(
      `[verify] mutation testing failed for ${suite}: ${result.stderr.trim().slice(-500)}`,
    );
    return null;
  }
  return {
    ...readStrykerReport(JSON.parse(readFileSync(reportPath, "utf8"))),
    skippedRanges: skipped,
  };
}
