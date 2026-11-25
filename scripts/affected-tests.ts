#!/usr/bin/env bun
/**
 * Runs only the test files that a branch's changes can reach, or the whole
 * suite when a change can't be traced that way.
 *
 * `bun test --changed=<base>` follows each test file's imports (text imports
 * of docs included) and runs the ones that reach a changed file. It can't see
 * a change that reaches tests another way: the preload, dependencies,
 * test config, or SQL migrations the sidecar reads at runtime. A change to
 * any path in a suite's `fullRunOn` runs the whole suite instead. Tests that
 * read repo files from disk or scan the source tree are in `alwaysRun`,
 * since no import links them to what they check. CI's push to main always
 * runs everything, which catches what this still misses.
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
  /** Test files, relative to `cwd`, that run on every affected run. */
  alwaysRun: string[];
}

const SHARED_FULL_RUN = [
  "package.json",
  "bun.lock",
  "sidecar/package.json",
  ".github/workflows/ci.yml",
  "scripts/affected-tests.ts",
];

/** sidecar/src/test/setup.ts and the modules whose state it resets. */
const SIDECAR_PRELOAD = [
  "sidecar/src/test/",
  "sidecar/src/azure/client.ts",
  "sidecar/src/github/client.ts",
  "sidecar/src/github/rateLimit.ts",
];

export const SUITES: Record<string, Suite> = {
  frontend: {
    cwd: ".",
    roots: ["./src", "./scripts", "./demo"],
    fullRunOn: [
      ...SHARED_FULL_RUN,
      "bunfig.toml",
      "tsconfig.json",
      // Both preloads, and what they import, run before every test.
      "src/test/",
      "src/lib/resourceCache.ts",
      ...SIDECAR_PRELOAD,
    ],
    alwaysRun: [
      // Scan every file under src/ for stubs that leak between suites.
      "./src/test/passThrough.test.ts",
      "./src/test/sidecarApi.test.ts",
      // Reads the yarvis-guide prompt from disk.
      "./src/lib/appPlace.test.ts",
    ],
  },
  sidecar: {
    cwd: "sidecar",
    // The sidecar's own `test` script is a bare `bun test`.
    roots: [],
    fullRunOn: [
      ...SHARED_FULL_RUN,
      "sidecar/bunfig.toml",
      "sidecar/tsconfig.json",
      ...SIDECAR_PRELOAD,
      // migrate.ts reads these from disk, so no test imports them.
      "sidecar/drizzle/",
    ],
    alwaysRun: [
      // Lists docs/features/ to catch a page help/docs.ts doesn't embed.
      "./src/help/docs.test.ts",
      // Read claude-plugins/ and agentRuns/fixtures/ from disk.
      "./src/agentRuns/plugins.test.ts",
      "./src/agentRuns/streamJson.test.ts",
      // Starts main.ts as a subprocess, which reaches most of the sidecar.
      "./src/channel/routes.test.ts",
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
  const tracked = git(["diff", "--name-only", "--no-renames", base]);
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
  if (baseIndex >= 0 && !ref) throw new Error("--base needs a git ref");
  const base = ref ? git(["rev-parse", ref]) : git(["merge-base", "HEAD", "origin/main"]);
  return { suite, base };
}

if (import.meta.main) {
  // git paths are relative to the repo root, wherever this was started.
  process.chdir(git(["rev-parse", "--show-toplevel"]));
  const { suite, base } = parseArgs(process.argv.slice(2));
  const trigger = fullRunTrigger(suite, changedFiles(base));
  const runs: string[][] = [];
  if (trigger) {
    console.info(`${trigger} changed, so running the whole suite.`);
    runs.push(["test", ...suite.roots]);
  } else {
    console.info(`Running the tests affected by changes since ${base.slice(0, 12)}.`);
    // A separate run, because bun intersects named files with --changed.
    runs.push(["test", ...suite.roots, `--changed=${base}`], ["test", ...suite.alwaysRun]);
  }
  let failed = false;
  for (const args of runs) {
    const result = spawnSync(process.execPath, args, { cwd: suite.cwd, stdio: "inherit" });
    if (result.error) console.error(result.error);
    if (result.status !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
