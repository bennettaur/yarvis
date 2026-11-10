/**
 * Runs a pull request's new and changed tests against the base branch's code.
 * A test that still passes there isn't checking anything the PR changed. That
 * is expected for a pure refactor and a warning sign for a feature or a fix.
 *
 * A test counts as new or changed only when the diff touches its own
 * `it(...)`/`test(...)` call. The PR's edits elsewhere in a test file (imports,
 * mock setup, hooks) don't make every older test in that file part of it.
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
import { parse } from "@babel/parser";
import type { LineRange } from "./diffCoverage.ts";
import { run } from "./exec.ts";
import { isTestFile } from "./tier.ts";

export type Outcome = "pass" | "fail" | "skip";

export interface TestCase {
  file: string;
  name: string;
  outcome: Outcome;
  /** A line inside the test's call, as bun reports it; `null` when the report has none. */
  line: number | null;
}

export interface BaselineResult {
  /** Tests that pass on the PR and fail (or don't load) on the base: they test the change. */
  detecting: number;
  /** Tests that pass on both, so they would not catch the change being reverted. */
  notDetecting: string[];
  /** Tests that fail on the PR itself. */
  failingOnHead: string[];
}

/**
 * The directories that run their own `bun test` suite, each with its own
 * bunfig. `""` is the repo root and must stay last: it catches every path.
 */
const SUITES = ["sidecar", ""];

/** Helpers and fixtures the tests import, which run in their PR versions too. */
const TEST_SUPPORT = /(^|\/)(test|tests|fixtures|__fixtures__)\//;

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
    const line = Number(attr(attrs, "line"));
    cases.push({
      file: prefix ? `${prefix}/${file}` : file,
      name: classname ? `${classname} > ${name}` : name,
      outcome,
      line: Number.isInteger(line) && line > 0 ? line : null,
    });
  }
  return cases;
}

const TEST_FUNCTIONS = new Set(["it", "test"]);

/** The parts of a Babel AST node this file reads. */
interface AstNode {
  type: string;
  loc?: { start: { line: number }; end: { line: number } };
  [key: string]: unknown;
}

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

/**
 * The name a call chain like `test.each(rows)(...)` or `it.only(...)` starts
 * from, and the calls inside the chain, such as `test.each(rows)`.
 */
function calleeChain(node: AstNode): { root: string | null; inner: AstNode[] } {
  const inner: AstNode[] = [];
  let current = node;
  while (current.type === "MemberExpression" || current.type === "CallExpression") {
    if (current.type === "CallExpression") inner.push(current);
    current = (current.type === "MemberExpression" ? current.object : current.callee) as AstNode;
  }
  return { root: current.type === "Identifier" ? (current.name as string) : null, inner };
}

/**
 * The line span of every `it(...)` and `test(...)` call in a test file, or
 * `null` when it can't be parsed.
 */
export function testSpans(source: string, path: string): LineRange[] | null {
  const spans: LineRange[] = [];
  // `test.each(rows)` is part of the test call around it, not a test of its own.
  const chained = new Set<AstNode>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isAstNode(value)) return;
    if (value.type === "CallExpression" && value.loc && !chained.has(value)) {
      const { root, inner } = calleeChain(value.callee as AstNode);
      if (root && TEST_FUNCTIONS.has(root)) {
        spans.push([value.loc.start.line, value.loc.end.line]);
        for (const call of inner) chained.add(call);
      }
    }
    // `loc` and the `*Comments` arrays are metadata about a node, not its children.
    for (const [key, child] of Object.entries(value)) {
      if (key !== "loc" && !key.endsWith("Comments")) visit(child);
    }
  };
  // The walk is inside the try too: a deeply nested file can overflow the stack.
  try {
    const { program } = parse(source, {
      sourceType: "module",
      plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
    });
    visit(program);
  } catch {
    return null;
  }
  return spans;
}

/**
 * Whether the diff touches the test's own call: the innermost span holding
 * the line bun gives for it, since a test can sit inside another's callback.
 * A test that can't be placed counts as changed, so nothing is hidden.
 */
export function isTouched(
  line: number | null,
  spans: LineRange[] | null,
  changed: LineRange[],
): boolean {
  if (line === null || spans === null) return true;
  const innermost = spans
    .filter(([start, end]) => start <= line && line <= end)
    .sort((a, b) => a[1] - a[0] - (b[1] - b[0]))[0];
  if (!innermost) return true;
  return changed.some(([from, to]) => innermost[0] <= from && to <= innermost[1]);
}

const testKey = (test: TestCase) => `${test.file} > ${test.name}`;

export function compareRuns(head: TestCase[], base: TestCase[]): BaselineResult {
  const baseByKey = new Map(base.map((test) => [testKey(test), test.outcome]));
  const result: BaselineResult = { detecting: 0, notDetecting: [], failingOnHead: [] };
  for (const test of head) {
    if (test.outcome === "skip") continue;
    if (test.outcome === "fail") {
      result.failingOnHead.push(testKey(test));
      continue;
    }
    // A test missing on the base usually means its file failed to load there,
    // because it imports something the PR adds. That counts as detecting.
    if (baseByKey.get(testKey(test)) === "pass") result.notDetecting.push(testKey(test));
    else result.detecting++;
  }
  return result;
}

function suiteFor(path: string): string {
  return SUITES.find((suite) => suite === "" || path.startsWith(`${suite}/`)) as string;
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
 * @param changedRanges where each file changed, from `parseChangedRanges`.
 */
export function runBaseline(
  root: string,
  base: string,
  changedFiles: string[],
  changedRanges: Map<string, LineRange[]>,
): BaselineResult {
  const testFiles = changedFiles.filter(isTestFile);
  const result: BaselineResult = { detecting: 0, notDetecting: [], failingOnHead: [] };
  if (testFiles.length === 0) return result;

  const spansByFile = new Map(
    testFiles.map((file) => [file, testSpans(readFileSync(join(root, file), "utf8"), file)]),
  );
  const scratch = mkdtempSync(join(tmpdir(), "verify-baseline-"));
  const baseTree = join(scratch, "base");
  try {
    run("git", ["worktree", "add", "--detach", baseTree, base], { cwd: root });
    // Reuse the PR checkout's installed packages rather than installing again.
    for (const dir of ["node_modules", "sidecar/node_modules"]) {
      if (existsSync(join(root, dir)) && !existsSync(join(baseTree, dir))) {
        symlinkSync(join(root, dir), join(baseTree, dir));
      }
    }
    for (const file of changedFiles.filter((path) => isTestFile(path) || TEST_SUPPORT.test(path))) {
      mkdirSync(dirname(join(baseTree, file)), { recursive: true });
      cpSync(join(root, file), join(baseTree, file));
    }

    for (const suite of SUITES) {
      const files = testFiles.filter((file) => suiteFor(file) === suite);
      if (files.length === 0) continue;
      const name = suite || "root";
      // A failure counts wherever it is: an edit to a shared mock can break a
      // test the diff never touched.
      const head = runSuite(root, suite, files, join(scratch, `${name}-head.xml`)).filter(
        (test) =>
          test.outcome === "fail" ||
          isTouched(
            test.line,
            spansByFile.get(test.file) ?? null,
            changedRanges.get(test.file) ?? [],
          ),
      );
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
