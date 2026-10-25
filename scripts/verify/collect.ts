#!/usr/bin/env bun
/**
 * Gathers the measurable facts for a verification report: the risk tier, diff
 * coverage, and whether the PR's tests fail without its change. The `/verify-pr`
 * skill runs this, then adds its review on top.
 *
 *   bun run verify:collect --base origin/main --out "$TMPDIR/verify/123" [--static]
 *
 * Run it from a clean checkout of the PR's head. The sidecar suite needs the
 * test database (TEST_DATABASE_URL), the same as `bun run sidecar:test`.
 *
 * `--mutation` also runs Stryker on the changed lines (see `mutation.ts`). It
 * is slow, so it's opt-in.
 *
 * `--static` reads the diff and runs nothing from the PR, for a PR whose code
 * isn't trusted to run on this machine. Coverage and the baseline are then
 * reported as unmeasured, and CI's test run is the evidence instead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BaselineResult, parseJunit, runBaseline } from "./baseline.ts";
import {
  type DiffCoverage,
  diffCoverage,
  type LineHits,
  mergeLineHits,
  parseAddedLines,
  parseAddedText,
  parseLcov,
} from "./diffCoverage.ts";
import { run } from "./exec.ts";
import { type MutationResult, mergeMutation, runMutation } from "./mutation.ts";
import { type ChangedFile, classify, isTestFile, type TierResult } from "./tier.ts";

export interface Facts {
  base: string;
  head: string;
  files: ChangedFile[];
  tier: TierResult;
  coverage: DiffCoverage;
  baseline: BaselineResult;
  /** Which suites ran, so the report can say what wasn't measured. */
  suites: string[];
  /** Mutation testing on the changed lines, when `--mutation` was passed and anything ran. */
  mutation?: MutationResult;
}

function git(root: string, args: string[]): string {
  return run("git", args, { cwd: root }).stdout.trim();
}

/**
 * `git diff` with the output shape the parsers expect, whatever the user's git
 * config says about prefixes, external diff tools or quoting non-ASCII paths.
 */
function gitDiff(root: string, args: string[]): string {
  return git(root, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    ...args,
  ]);
}

/** Reads `git diff --numstat`. Binary files report "-" and count as zero lines. */
export function parseNumstat(numstat: string): ChangedFile[] {
  return numstat
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [additions, deletions, ...path] = line.split("\t");
      return {
        path: path.join("\t"),
        additions: Number(additions) || 0,
        deletions: Number(deletions) || 0,
      };
    });
}

/** The suite directory a changed file's tests run in: the sidecar's own, or the root's. */
function bunSuiteOf(path: string): string {
  return path.startsWith("sidecar/") ? "sidecar" : "";
}

export function collectCoverage(root: string, out: string, paths: string[]) {
  const hits: LineHits[] = [];
  const suites: string[] = [];
  const ranSuites = new Set<string>();
  let rustRan = false;

  const touchesRoot = paths.some((p) => /^(src|scripts|demo)\//.test(p));
  const touchesSidecar = paths.some((p) => p.startsWith("sidecar/"));
  const touchesRust = paths.some((p) => p.startsWith("src-tauri/") && p.endsWith(".rs"));

  const bunCoverage = (suite: string, name: string, args: string[]) => {
    const dir = join(out, `coverage-${name}`);
    const junit = join(dir, "junit.xml");
    // Failing tests are CI's to report; coverage of the passing ones is still useful.
    run(
      "bun",
      [
        "test",
        ...args,
        "--coverage",
        "--coverage-reporter=lcov",
        `--coverage-dir=${dir}`,
        "--reporter=junit",
        `--reporter-outfile=${junit}`,
      ],
      { cwd: suite ? join(root, suite) : root, allowFailure: true },
    );
    const lcov = join(dir, "lcov.info");
    // A suite that ran no tests says nothing about coverage, and bun still
    // writes lcov when a preload crashes. Without this check, every changed
    // file in the suite would be reported as one no test loads.
    const ranTests = existsSync(junit) && parseJunit(readFileSync(junit, "utf8"), suite).length > 0;
    if (!existsSync(lcov) || !ranTests) return;
    hits.push(parseLcov(readFileSync(lcov, "utf8"), suite, root));
    suites.push(name);
    ranSuites.add(suite);
  };

  if (touchesRoot) bunCoverage("", "frontend", ["./src", "./scripts", "./demo"]);
  if (touchesSidecar) bunCoverage("sidecar", "sidecar", []);

  // Only asked when Rust changed: a machine with no cargo at all throws here.
  if (touchesRust && run("cargo", ["llvm-cov", "--version"], { allowFailure: true }).status === 0) {
    const lcov = join(out, "coverage-rust.info");
    run("cargo", ["llvm-cov", "--all-targets", "--lcov", "--output-path", lcov], {
      cwd: join(root, "src-tauri"),
      allowFailure: true,
    });
    if (existsSync(lcov)) {
      hits.push(parseLcov(readFileSync(lcov, "utf8"), "", root));
      rustRan = true;
      suites.push("rust");
    }
  }

  const measured = (path: string) =>
    path.endsWith(".rs") ? rustRan : ranSuites.has(bunSuiteOf(path));
  return { hits: mergeLineHits(...hits), measured, suites };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      out: { type: "string" },
      static: { type: "boolean", default: false },
      mutation: { type: "boolean", default: false },
    },
  });
  if (!values.out) throw new Error("--out <dir> is required");
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });

  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (git(root, ["status", "--porcelain"])) {
    throw new Error(
      "the working tree has uncommitted changes; the facts must describe the PR head",
    );
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const base = git(root, ["merge-base", values.base as string, "HEAD"]);

  const unified = gitDiff(root, ["-U0", base, head]);
  const addedText = parseAddedText(unified);
  const files = parseNumstat(gitDiff(root, ["--numstat", base, head])).map((file) => ({
    ...file,
    addedText: addedText.get(file.path) ?? "",
  }));
  const addedOrModified = gitDiff(root, ["--name-only", "--diff-filter=AM", base, head])
    .split("\n")
    .filter(Boolean);
  const added = parseAddedLines(unified);

  const measuredRun = values.static
    ? null
    : collectCoverage(
        root,
        out,
        files.map((file) => file.path),
      );
  const facts: Facts = {
    base,
    head,
    files,
    tier: classify(files),
    coverage: diffCoverage(
      added,
      measuredRun?.hits ?? new Map(),
      measuredRun?.measured ?? (() => false),
    ),
    baseline: measuredRun
      ? runBaseline(root, base, addedOrModified)
      : { detecting: 0, notDetecting: [], failingOnHead: [] },
    suites: measuredRun?.suites ?? [],
  };
  // Mutants are judged by whether tests fail, which means nothing while some already do.
  if (values.mutation && measuredRun && facts.baseline.failingOnHead.length === 0) {
    const changedTests = addedOrModified.filter(isTestFile);
    const results = (["frontend", "sidecar"] as const)
      .map((suite) =>
        runMutation({ root, suite, out, added, hits: measuredRun.hits, changedTests }),
      )
      .filter((result) => result !== null);
    if (results.length > 0) facts.mutation = mergeMutation(results);
  }
  const path = join(out, "facts.json");
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(path);
}
