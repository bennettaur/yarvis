import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runBaseline } from "./baseline.ts";
import { collectCoverage } from "./collect.ts";
import { run } from "./exec.ts";

// The runners' bugs would be in how they call git and bun, so these run both
// for real in throwaway repos. They're kept apart from the parser tests in
// baseline.test.ts and collect.test.ts because they're slower.

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeAll(root: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// No signing or hooks from the user's git config: these commits are throwaway.
const git = (root: string, ...args: string[]) =>
  run("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: root,
  }).stdout.trim();

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verify-runners-"));
  made.push(root);
  writeAll(root, files);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  return root;
}

/** Commits the PR's side on top of the repo's first commit, and returns that first commit. */
function commitPr(root: string, files: Record<string, string>): string {
  writeAll(root, files);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "head");
  return git(root, "rev-parse", "HEAD~1");
}

describe("runBaseline", () => {
  it("runs each suite's changed tests on both sides and cleans up its worktree", () => {
    const root = repo({
      "src/clamp.ts": "export const clamp = (n: number) => n;\n",
      "sidecar/src/same.ts": "export const same = 1;\n",
      // Only applies when the sidecar's tests run from sidecar/, as its suite must.
      "sidecar/bunfig.toml": '[test]\npreload = ["./src/setup.ts"]\n',
      "sidecar/src/setup.ts": '(globalThis as { suite?: string }).suite = "sidecar";\n',
    });
    const base = commitPr(root, {
      "src/clamp.ts": "export const clamp = (n: number) => Math.min(n, 10);\n",
      "src/clamp.test.ts": `import { expect, it } from "bun:test";
import { clamp } from "./clamp.ts";
it("keeps small numbers", () => expect(clamp(3)).toBe(3));
it("caps at 10", () => expect(clamp(30)).toBe(10));
it("is wrong", () => expect(clamp(1)).toBe(2));
`,
      "sidecar/src/same.test.ts": `import { expect, it } from "bun:test";
import { same } from "./same.ts";
it("is one", () => expect(same).toBe(1));
it("runs with the sidecar's bunfig", () => expect((globalThis as { suite?: string }).suite).toBe("sidecar"));
`,
    });

    const result = runBaseline(root, base, [
      "src/clamp.ts",
      "src/clamp.test.ts",
      "sidecar/src/same.test.ts",
    ]);

    expect(result).toEqual({
      detecting: 1,
      // SUITES order: the sidecar's suite runs before the root's.
      notDetecting: [
        "sidecar/src/same.test.ts > is one",
        "sidecar/src/same.test.ts > runs with the sidecar's bunfig",
        "src/clamp.test.ts > keeps small numbers",
      ],
      failingOnHead: ["src/clamp.test.ts > is wrong"],
    });
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("runs nothing when no test changed", () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n" });
    const base = commitPr(root, { "src/a.ts": "export const a = 2;\n" });
    expect(runBaseline(root, base, ["src/a.ts"])).toEqual({
      detecting: 0,
      notDetecting: [],
      failingOnHead: [],
    });
  });
});

describe("collectCoverage", () => {
  const source = {
    "src/a.ts": "export function a(n: number) {\n  if (n > 0) return 1;\n  return 0;\n}\n",
    "src/a.test.ts": `import { expect, it } from "bun:test";
import { a } from "./a.ts";
it("is one", () => expect(a(1)).toBe(1));
`,
  };

  it("reads line hits for the suites the changed files belong to", () => {
    const root = repo(source);
    const out = join(root, "out");
    const result = collectCoverage(root, out, ["src/a.ts"]);
    expect(result.suites).toEqual(["frontend"]);
    expect(result.measurement("src/a.ts")).toBe("measured");
    const lines = result.hits.get("src/a.ts");
    expect(lines?.get(2)).toBeGreaterThan(0);
    expect(lines?.get(3)).toBe(0);
  });

  it("keys the sidecar's coverage by repo path", () => {
    const root = repo({
      "sidecar/src/a.ts": source["src/a.ts"],
      "sidecar/src/a.test.ts": source["src/a.test.ts"],
    });
    const result = collectCoverage(root, join(root, "out"), ["sidecar/src/a.ts"]);
    expect(result.suites).toEqual(["sidecar"]);
    expect(result.hits.get("sidecar/src/a.ts")?.get(2)).toBeGreaterThan(0);
  });

  it("measures nothing when the suite wrote no coverage", () => {
    // bun writes no lcov when it finds no test files to run.
    const root = repo({ "src/a.ts": source["src/a.ts"] });
    const result = collectCoverage(root, join(root, "out"), ["src/a.ts"]);
    expect(result.suites).toEqual([]);
    expect(result.measurement("src/a.ts")).toBe("no-tests");
  });

  it("measures nothing for a suite whose preload crashed, though bun wrote lcov", () => {
    const root = repo({
      ...source,
      "bunfig.toml": '[test]\npreload = ["./crash.ts"]\n',
      "crash.ts": 'throw new Error("preload failed");\n',
    });
    const result = collectCoverage(root, join(root, "out"), ["src/a.ts"]);
    expect(result.suites).toEqual([]);
    expect(result.measurement("src/a.ts")).toBe("no-tests");
  });

  it("ignores a JUnit report left by an earlier run into the same directory", () => {
    const root = repo(source);
    const out = join(root, "out");
    expect(collectCoverage(root, out, ["src/a.ts"]).measurement("src/a.ts")).toBe("measured");
    writeAll(root, {
      "bunfig.toml": '[test]\npreload = ["./crash.ts"]\n',
      "crash.ts": 'throw new Error("preload failed");\n',
    });
    expect(collectCoverage(root, out, ["src/a.ts"]).measurement("src/a.ts")).toBe("no-tests");
  });

  it("counts a root file no suite covers as not run", () => {
    const root = repo(source);
    const result = collectCoverage(root, join(root, "out"), ["src/a.ts", "vite.config.ts"]);
    expect(result.measurement("vite.config.ts")).toBe("not-run");
  });

  it("still measures one suite when the other crashed", () => {
    const root = repo({
      ...source,
      "sidecar/src/b.ts": source["src/a.ts"],
      "sidecar/src/b.test.ts": source["src/a.test.ts"].replace("./a.ts", "./b.ts"),
      "sidecar/bunfig.toml": '[test]\npreload = ["./crash.ts"]\n',
      "sidecar/crash.ts": 'throw new Error("preload failed");\n',
    });
    const result = collectCoverage(root, join(root, "out"), ["src/a.ts", "sidecar/src/b.ts"]);
    expect(result.suites).toEqual(["frontend"]);
    expect(result.measurement("src/a.ts")).toBe("measured");
    expect(result.measurement("sidecar/src/b.ts")).toBe("no-tests");
    expect(result.measurement("src-tauri/src/x.rs")).toBe("not-run");
  });
});
