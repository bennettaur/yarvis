#!/usr/bin/env bun
/**
 * Runs only the test files that a branch's changes can reach, or the whole
 * suite when a change can't be traced that way.
 *
 * `bun test --changed=<base>` follows each test file's imports (text imports
 * of docs included) and runs the ones that reach a changed file. It can't see
 * a change that reaches tests another way: the preload, dependencies,
 * test config, or SQL migrations the sidecar reads at runtime. A change to
 * any path in a suite's `fullRunOn` runs the whole suite instead. CI's push
 * to main always runs everything, which catches what this still misses.
 *
 *   bun run test:affected                    # frontend + dev-script tests
 *   bun run sidecar:test:affected            # sidecar tests
 *   bun run scripts/affected-tests.ts sidecar --base HEAD^1
 *
 * The base defaults to where the branch left origin/main, so commits that
 * landed on main since don't pull in their tests.
 */

import { spawnSync } from "node:child_process";

interface Suite {
  /** Directory `bun test` runs in, from the repo root. */
  cwd: string;
  /** Paths handed to `bun test`, the same ones the suite's npm script uses. */
  roots: string[];
  /** Repo-root paths whose change runs the whole suite. A trailing `/` matches a folder. */
  fullRunOn: string[];
}

const SHARED_FULL_RUN = [
  "package.json",
  "bun.lock",
  "sidecar/package.json",
  ".github/workflows/ci.yml",
  "scripts/affected-tests.ts",
];

export const SUITES: Record<string, Suite> = {
  frontend: {
    cwd: ".",
    roots: ["./src", "./scripts", "./demo"],
    fullRunOn: [
      ...SHARED_FULL_RUN,
      "bunfig.toml",
      "tsconfig.json",
      // Both preloads run before every test, and nothing imports them.
      "src/test/",
      "sidecar/src/test/",
    ],
  },
  sidecar: {
    cwd: "sidecar",
    roots: [],
    fullRunOn: [
      ...SHARED_FULL_RUN,
      "sidecar/bunfig.toml",
      "sidecar/tsconfig.json",
      "sidecar/src/test/",
      // migrate.ts reads these from disk, so no test imports them.
      "sidecar/drizzle/",
    ],
  },
};

/** The first changed file that means the whole suite has to run, or `null`. */
export function fullRunTrigger(suite: Suite, changed: string[]): string | null {
  return (
    changed.find((file) =>
      suite.fullRunOn.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
    ) ?? null
  );
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Files that differ from `base` in the working tree, untracked ones included. */
function changedFiles(base: string): string[] {
  const tracked = git(["diff", "--name-only", base]);
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  return [tracked, untracked].join("\n").split("\n").filter(Boolean);
}

function parseArgs(argv: string[]): { suite: Suite; base: string } {
  const [name, ...rest] = argv;
  const suite = name ? SUITES[name] : undefined;
  if (!suite) {
    throw new Error(`usage: affected-tests.ts <${Object.keys(SUITES).join("|")}> [--base <ref>]`);
  }
  const baseIndex = rest.indexOf("--base");
  const ref = baseIndex >= 0 ? rest[baseIndex + 1] : undefined;
  const base = ref ? git(["rev-parse", ref]) : git(["merge-base", "HEAD", "origin/main"]);
  return { suite, base };
}

if (import.meta.main) {
  // git paths are relative to the repo root, wherever this was started.
  process.chdir(git(["rev-parse", "--show-toplevel"]));
  const { suite, base } = parseArgs(process.argv.slice(2));
  const trigger = fullRunTrigger(suite, changedFiles(base));
  const args = ["test", ...suite.roots];
  if (trigger) {
    console.log(`${trigger} changed, so running the whole suite.`);
  } else {
    console.log(`Running the tests affected by changes since ${base.slice(0, 12)}.`);
    args.push(`--changed=${base}`);
  }
  const result = spawnSync(process.execPath, args, { cwd: suite.cwd, stdio: "inherit" });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
