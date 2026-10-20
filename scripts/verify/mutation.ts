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
}

/** Past this many ranges a run takes longer than the review it feeds. */
const MAX_RANGES = 40;

/**
 * Stryker `mutate` entries (`path:start-end`) covering each changed file's
 * added lines that a test ran. Lines no test ran are already reported by diff
 * coverage, and every mutant on them would survive, so they are left out.
 */
export function mutationTargets(added: AddedLines, hits: LineHits, suite: string): string[] {
  const targets: string[] = [];
  for (const [path, lines] of added) {
    if (!/\.tsx?$/.test(path) || isTestFile(path) || path.endsWith(".d.ts")) continue;
    if (suite ? !path.startsWith(`${suite}/`) : path.startsWith("sidecar/")) continue;
    const fileHits = hits.get(path);
    if (!fileHits) continue;
    const covered = [...lines]
      .filter((line) => (fileHits.get(line) ?? 0) > 0)
      .sort((a, b) => a - b);
    const local = suite ? path.slice(suite.length + 1) : path;
    let start = covered[0];
    for (let i = 1; i <= covered.length; i++) {
      if (covered[i] === covered[i - 1] + 1) continue;
      if (start !== undefined) targets.push(`${local}:${start}-${covered[i - 1]}`);
      start = covered[i];
    }
  }
  return targets.slice(0, MAX_RANGES);
}

/**
 * The tests to run against each mutant: the PR's own changed tests in this
 * suite, plus each mutated file's sibling `*.test.ts(x)`, which is how this
 * repo pairs code and tests.
 */
export function relatedTests(
  root: string,
  suite: string,
  targets: string[],
  changedTests: string[],
): string[] {
  const inSuite = (path: string) =>
    suite ? path.startsWith(`${suite}/`) : !path.startsWith("sidecar/");
  const local = (path: string) => (suite ? path.slice(suite.length + 1) : path);
  const tests = new Set(changedTests.filter(inSuite).map(local));
  for (const target of targets) {
    const file = target.slice(0, target.lastIndexOf(":"));
    for (const sibling of [
      file.replace(/\.tsx?$/, ".test.ts"),
      file.replace(/\.tsx?$/, ".test.tsx"),
    ]) {
      if (existsSync(join(root, suite, sibling))) tests.add(sibling);
    }
  }
  return [...tests].sort();
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

/** Statuses that say nothing about the tests: the mutant didn't compile or wasn't run. */
const NOT_RUN = new Set(["CompileError", "RuntimeError", "Ignored", "Pending"]);

export function readStrykerReport(report: StrykerReport, prefix: string): MutationResult {
  let killed = 0;
  let total = 0;
  const survived: string[] = [];
  for (const [file, { mutants }] of Object.entries(report.files)) {
    for (const mutant of mutants) {
      if (NOT_RUN.has(mutant.status)) continue;
      total++;
      if (mutant.status === "Killed" || mutant.status === "Timeout") {
        killed++;
      } else {
        const path = prefix ? `${prefix}/${file}` : file;
        const change = mutant.replacement ? ` → ${mutant.replacement.split("\n")[0]}` : "";
        survived.push(`${path}:${mutant.location.start.line} ${mutant.mutatorName}${change}`);
      }
    }
  }
  return { score: total > 0 ? killed / total : null, killed, survived };
}

export function mergeMutation(results: MutationResult[]): MutationResult {
  const killed = results.reduce((sum, r) => sum + r.killed, 0);
  const survived = results.flatMap((r) => r.survived);
  const total = killed + survived.length;
  return { score: total > 0 ? killed / total : null, killed, survived };
}

/** Runs Stryker for one suite. Returns `null` if there was nothing to mutate or no test to run. */
export function runMutation(input: {
  root: string;
  suite: string;
  out: string;
  added: AddedLines;
  hits: LineHits;
  changedTests: string[];
}): MutationResult | null {
  const { root, suite, out } = input;
  const targets = mutationTargets(input.added, input.hits, suite);
  const tests = relatedTests(root, suite, targets, input.changedTests);
  if (targets.length === 0 || tests.length === 0) return null;

  const name = suite || "frontend";
  const reportPath = join(out, `mutation-${name}.json`);
  const config = join(out, `stryker-${name}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      testRunner: "command",
      // `process.execPath` is the bun running this script, so mutants run on the same one.
      commandRunner: {
        command: `${process.execPath} test ${tests.map((t) => `./${t}`).join(" ")}`,
      },
      mutate: targets,
      coverageAnalysis: "off",
      // Stryker rewrites tsconfig references with an API TypeScript 7 dropped.
      // Bun doesn't read them, so a name that doesn't exist skips the rewrite.
      tsconfigFile: "no-tsconfig-for-stryker.json",
      reporters: ["json"],
      jsonReporter: { fileName: reportPath },
      tempDirName: join(out, `stryker-tmp-${name}`),
      cleanTempDir: "always",
    }),
  );
  // Surviving mutants make Stryker exit non-zero only below a break threshold,
  // which isn't set; a non-zero exit here is a failed run.
  run(join(root, "node_modules/.bin/stryker"), ["run", config], { cwd: join(root, suite) });
  if (!existsSync(reportPath)) return null;
  return readStrykerReport(JSON.parse(readFileSync(reportPath, "utf8")), suite);
}
