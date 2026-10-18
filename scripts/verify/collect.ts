#!/usr/bin/env bun
/**
 * Gathers the measurable facts for a verification report: the risk tier, diff
 * coverage, and whether the PR's tests fail without its change. The `/verify-pr`
 * skill runs this, then adds its review on top.
 *
 *   bun run verify:collect --base origin/main --out "$TMPDIR/verify/123"
 *
 * Run it from a clean checkout of the PR's head. The sidecar suite needs the
 * test database (TEST_DATABASE_URL), the same as `bun run sidecar:test`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { type BaselineResult, runBaseline } from "./baseline.ts";
import {
  type DiffCoverage,
  diffCoverage,
  type LineHits,
  mergeLineHits,
  parseAddedLines,
  parseLcov,
} from "./diffCoverage.ts";
import { run } from "./exec.ts";
import { type ChangedFile, classify, type TierResult } from "./tier.ts";

export interface Facts {
  base: string;
  head: string;
  files: ChangedFile[];
  tier: TierResult;
  coverage: DiffCoverage;
  baseline: BaselineResult;
  /** Which suites ran, so the report can say what wasn't measured. */
  suites: string[];
}

function git(root: string, args: string[]): string {
  return run("git", args, { cwd: root }).stdout.trim();
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

function collectCoverage(root: string, out: string, paths: string[]) {
  const hits: LineHits[] = [];
  const suites: string[] = [];
  const measured: string[] = [];

  const touchesRoot = paths.some((p) => /^(src|scripts|demo)\//.test(p));
  const touchesSidecar = paths.some((p) => p.startsWith("sidecar/"));
  const touchesRust = paths.some((p) => p.startsWith("src-tauri/") && p.endsWith(".rs"));

  const bunCoverage = (suite: string, args: string[]) => {
    const dir = join(out, `coverage-${suite || "root"}`);
    // Failing tests are CI's to report; coverage of the passing ones is still useful.
    run(
      "bun",
      ["test", ...args, "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${dir}`],
      { cwd: suite ? join(root, suite) : root, allowFailure: true },
    );
    const lcov = join(dir, "lcov.info");
    if (existsSync(lcov)) hits.push(parseLcov(readFileSync(lcov, "utf8"), suite, root));
    suites.push(suite || "frontend");
  };

  if (touchesRoot) bunCoverage("", ["./src", "./scripts", "./demo"]);
  if (touchesSidecar) bunCoverage("sidecar", []);
  if (touchesRoot || touchesSidecar) measured.push(".ts", ".tsx");

  const hasLlvmCov = run("cargo", ["llvm-cov", "--version"], { allowFailure: true }).status === 0;
  if (touchesRust && hasLlvmCov) {
    const lcov = join(out, "coverage-rust.info");
    run("cargo", ["llvm-cov", "--all-targets", "--lcov", "--output-path", lcov], {
      cwd: join(root, "src-tauri"),
      allowFailure: true,
    });
    if (existsSync(lcov)) {
      hits.push(parseLcov(readFileSync(lcov, "utf8"), "", root));
      measured.push(".rs");
      suites.push("rust");
    }
  }

  return { hits: mergeLineHits(...hits), measured, suites };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      out: { type: "string" },
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
  const base = git(root, ["merge-base", values.base ?? "origin/main", "HEAD"]);

  const files = parseNumstat(git(root, ["diff", "--numstat", "--no-renames", base, head]));
  const paths = files.map((file) => file.path);
  const present = git(root, ["diff", "--name-only", "--no-renames", "--diff-filter=AM", base, head])
    .split("\n")
    .filter(Boolean);

  const { hits, measured, suites } = collectCoverage(root, out, paths);
  const added = parseAddedLines(
    git(root, ["diff", "-U0", "--no-color", "--no-renames", base, head]),
  );

  const facts: Facts = {
    base,
    head,
    files,
    tier: classify(files),
    coverage: diffCoverage(added, hits, measured),
    baseline: runBaseline(root, base, present),
    suites,
  };
  const path = join(out, "facts.json");
  writeFileSync(path, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(path);
}
