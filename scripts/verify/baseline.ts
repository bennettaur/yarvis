/**
 * Runs a pull request's new and changed tests against the base branch's code.
 * A test that still passes there isn't checking anything the PR changed. That
 * is expected for a pure refactor and a warning sign for a feature or a fix.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "./exec.ts";

export type Outcome = "pass" | "fail" | "skip";

export interface TestCase {
  file: string;
  name: string;
  outcome: Outcome;
}

export interface BaselineResult {
  /** Tests that pass on the PR and fail (or don't load) on the base: they test the change. */
  detecting: number;
  /** Tests that pass on both, so they would not catch the change being reverted. */
  notDetecting: string[];
  /** Tests that fail on the PR itself. */
  failingOnHead: string[];
  /** Changed test files this check can't run, such as Rust's inline tests. */
  unmeasured: string[];
}

/** The directories that run their own `bun test` suite, each with its own bunfig. */
const SUITES = ["sidecar", ""];

function decodeXml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attr(attrs: string, name: string): string {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

/** Reads the testcases out of bun's JUnit report. */
export function parseJunit(xml: string, prefix: string): TestCase[] {
  const cases: TestCase[] = [];
  const pattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const attrs = match[1];
    const body = match[2] ?? "";
    const outcome: Outcome = /<(failure|error)\b/.test(body)
      ? "fail"
      : /<skipped\b/.test(body)
        ? "skip"
        : "pass";
    const file = attr(attrs, "file");
    const classname = attr(attrs, "classname");
    const name = attr(attrs, "name");
    cases.push({
      file: prefix ? `${prefix}/${file}` : file,
      name: classname ? `${classname} > ${name}` : name,
      outcome,
    });
  }
  return cases;
}

const key = (test: TestCase) => `${test.file} > ${test.name}`;

export function compareRuns(
  head: TestCase[],
  base: TestCase[],
): Omit<BaselineResult, "unmeasured"> {
  const baseByKey = new Map(base.map((test) => [key(test), test.outcome]));
  const result = { detecting: 0, notDetecting: [] as string[], failingOnHead: [] as string[] };
  for (const test of head) {
    if (test.outcome === "skip") continue;
    if (test.outcome === "fail") {
      result.failingOnHead.push(key(test));
      continue;
    }
    // A test missing on the base usually means its file failed to load there,
    // because it imports something the PR adds. That counts as detecting.
    if (baseByKey.get(key(test)) === "pass") result.notDetecting.push(key(test));
    else result.detecting++;
  }
  return result;
}

function suiteFor(path: string): string {
  return SUITES.find((suite) => suite === "" || path.startsWith(`${suite}/`)) ?? "";
}

function runSuite(root: string, suite: string, files: string[], outFile: string): TestCase[] {
  const cwd = suite ? join(root, suite) : root;
  const relative = files.map((file) => (suite ? `./${file.slice(suite.length + 1)}` : `./${file}`));
  // A failing test exits non-zero, which is a result here, not an error.
  run("bun", ["test", ...relative, "--reporter=junit", `--reporter-outfile=${outFile}`], {
    cwd,
    allowFailure: true,
  });
  return existsSync(outFile) ? parseJunit(readFileSync(outFile, "utf8"), suite) : [];
}

/**
 * @param root the PR's checkout, on its head commit.
 * @param base the commit the PR branched from, usually `git merge-base origin/main HEAD`.
 * @param changedFiles repo-relative paths of files the PR added or modified.
 */
export function runBaseline(root: string, base: string, changedFiles: string[]): BaselineResult {
  const testFiles = changedFiles.filter((path) => /\.test\.tsx?$/.test(path));
  const unmeasured = changedFiles.filter((path) => path.endsWith(".rs"));
  const result: BaselineResult = { detecting: 0, notDetecting: [], failingOnHead: [], unmeasured };
  if (testFiles.length === 0) return result;

  const scratch = mkdtempSync(join(tmpdir(), "verify-baseline-"));
  const baseTree = join(scratch, "base");
  run("git", ["worktree", "add", "--detach", baseTree, base], { cwd: root });
  try {
    // Reuse the PR checkout's installed packages rather than installing again.
    for (const dir of ["node_modules", "sidecar/node_modules"]) {
      if (existsSync(join(root, dir)) && !existsSync(join(baseTree, dir))) {
        symlinkSync(join(root, dir), join(baseTree, dir));
      }
    }
    for (const file of testFiles) {
      mkdirSync(dirname(join(baseTree, file)), { recursive: true });
      cpSync(join(root, file), join(baseTree, file));
    }

    for (const suite of SUITES) {
      const files = testFiles.filter((file) => suiteFor(file) === suite);
      if (files.length === 0) continue;
      const name = suite || "root";
      const head = runSuite(root, suite, files, join(scratch, `${name}-head.xml`));
      const baseRun = runSuite(baseTree, suite, files, join(scratch, `${name}-base.xml`));
      const compared = compareRuns(head, baseRun);
      result.detecting += compared.detecting;
      result.notDetecting.push(...compared.notDetecting);
      result.failingOnHead.push(...compared.failingOnHead);
    }
  } finally {
    run("git", ["worktree", "remove", "--force", baseTree], { cwd: root, allowFailure: true });
    rmSync(scratch, { recursive: true, force: true });
  }
  return result;
}
