/**
 * The test commands mutation testing may run, and how many tests each one
 * reports. The planning run proposes a command per group of test files; the
 * sidecar runs it only when it starts with one of the runners below.
 *
 * The allowlist is about what the *planner* can make the sidecar start, not
 * about the PR's code: every runner here runs code from the PR (a test file, a
 * `package.json` script), which the user consented to and the sandbox
 * contains. What it rules out is a model choosing some other program, loading
 * code from somewhere the PR didn't put it (`--require`, `-toolexec`, a config
 * file), or fetching a package (`npx` of something not installed).
 */

import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

type Family =
  | "bun"
  | "jest"
  | "vitest"
  | "mocha"
  | "node"
  | "pytest"
  | "go"
  | "cargo"
  | "rspec"
  | "mix"
  | "dotnet"
  | "script";

/**
 * Runner prefixes and which output they print. `npm test` and the like run a
 * script whose runner we can't know, so their output is read by trying each
 * family's summary in turn.
 */
const RUNNERS: { prefix: string[]; family: Family }[] = [
  { prefix: ["bun", "test"], family: "bun" },
  { prefix: ["bun", "run", "test"], family: "script" },
  { prefix: ["bunx", "vitest"], family: "vitest" },
  { prefix: ["bunx", "jest"], family: "jest" },
  { prefix: ["npm", "test"], family: "script" },
  { prefix: ["npm", "run", "test"], family: "script" },
  { prefix: ["npx", "vitest"], family: "vitest" },
  { prefix: ["npx", "jest"], family: "jest" },
  { prefix: ["npx", "mocha"], family: "mocha" },
  { prefix: ["yarn", "test"], family: "script" },
  { prefix: ["yarn", "vitest"], family: "vitest" },
  { prefix: ["yarn", "jest"], family: "jest" },
  { prefix: ["pnpm", "test"], family: "script" },
  { prefix: ["pnpm", "vitest"], family: "vitest" },
  { prefix: ["pnpm", "jest"], family: "jest" },
  { prefix: ["pnpm", "exec", "vitest"], family: "vitest" },
  { prefix: ["pnpm", "exec", "jest"], family: "jest" },
  { prefix: ["node", "--test"], family: "node" },
  { prefix: ["pytest"], family: "pytest" },
  { prefix: ["python", "-m", "pytest"], family: "pytest" },
  { prefix: ["python3", "-m", "pytest"], family: "pytest" },
  { prefix: ["uv", "run", "pytest"], family: "pytest" },
  { prefix: ["poetry", "run", "pytest"], family: "pytest" },
  { prefix: ["go", "test"], family: "go" },
  { prefix: ["cargo", "test"], family: "cargo" },
  { prefix: ["bundle", "exec", "rspec"], family: "rspec" },
  { prefix: ["rspec"], family: "rspec" },
  { prefix: ["mix", "test"], family: "mix" },
  { prefix: ["dotnet", "test"], family: "dotnet" },
];

/** The runner prefixes, for the planning prompt. */
export const TEST_RUNNER_PREFIXES = RUNNERS.map((runner) => runner.prefix.join(" "));

const MAX_ARGS = 40;
const MAX_ARG_CHARS = 300;

/** Node-based runners' flags that load code, a config file or a plugin from a path. */
const NODE_LOADING_FLAGS = [
  "require",
  "r",
  "import",
  "loader",
  "experimental-loader",
  "e",
  "eval",
  "p",
  "print",
  "preload",
  "config",
  "c",
  "config-file",
  "setupFiles",
  "setup-files",
  "setupFilesAfterEnv",
  "globalSetup",
  "globalTeardown",
  "testEnvironment",
  "env",
  "environment",
  "reporters",
  "reporter",
  "transform",
  "resolver",
  "runner",
  "testRunner",
  "preset",
  "projects",
  "rootDir",
  "root",
  "node-options",
];

/**
 * Flags refused per runner family, compared without their leading dashes and
 * any `=value`. Each one loads code, configuration or a plugin from a path the
 * planner names, or (for npm) runs a shell of its choosing.
 */
const LOADING_FLAGS: Record<Family, readonly string[]> = {
  bun: NODE_LOADING_FLAGS,
  jest: NODE_LOADING_FLAGS,
  vitest: NODE_LOADING_FLAGS,
  mocha: [...NODE_LOADING_FLAGS, "file", "ui", "u"],
  node: [...NODE_LOADING_FLAGS, "test-reporter", "test-reporter-destination"],
  script: [
    ...NODE_LOADING_FLAGS,
    "userconfig",
    "globalconfig",
    "prefix",
    "script-shell",
    "workspace",
    "w",
  ],
  pytest: ["p", "c", "config-file", "o", "override-ini", "confcutdir", "rootdir", "pyargs"],
  go: ["exec", "toolexec", "overlay", "modfile", "pkgdir", "C"],
  cargo: ["config", "Z", "manifest-path"],
  rspec: ["r", "require", "I", "options", "default-path"],
  mix: ["r", "require", "exs"],
  dotnet: ["logger", "l", "collect", "settings", "s", "test-adapter-path", "a", "diag", "d"],
};

/** Families whose single-dash flags are long names (`-run`), never bundled letters. */
const SINGLE_DASH_LONG: ReadonlySet<Family> = new Set(["go"]);

/** Launchers that would fetch a package that isn't installed; run only from node_modules/.bin. */
const PACKAGE_LAUNCHERS = new Set(["npx", "bunx"]);

function loadingFlagProblem(family: Family, argv: string[], prefixLength: number): string | null {
  const denied = new Set(LOADING_FLAGS[family]);
  for (const arg of argv.slice(prefixLength)) {
    if (arg === "--") continue;
    if (!arg.startsWith("-")) continue;
    const name = (arg.split("=")[0] ?? "").replace(/^-+/, "");
    if (denied.has(name)) return `\`${arg}\` loads code or configuration and isn't allowed`;
    // A bundled short flag with its value attached: `-rsetup.js`.
    if (!SINGLE_DASH_LONG.has(family) && /^-[A-Za-z]/.test(arg) && !arg.startsWith("--")) {
      const letter = arg.slice(1, 2);
      if (denied.has(letter)) return `\`${arg}\` loads code or configuration and isn't allowed`;
    }
  }
  return null;
}

function runnerOf(argv: string[]): (typeof RUNNERS)[number] | null {
  // Longest prefix first, so `bun run test` isn't read as `bun …`.
  const matches = RUNNERS.filter(
    (runner) =>
      runner.prefix.length <= argv.length && runner.prefix.every((part, i) => argv[i] === part),
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0] ?? null;
}

function familyOf(argv: string[]): Family | null {
  return runnerOf(argv)?.family ?? null;
}

/**
 * Why `argv` may not run, or null when it may. Beyond the runner prefix, each
 * argument must be a plain relative path, flag or filter: nothing absolute or
 * home-relative, no `..`, no control characters. No shell ever sees it.
 */
export function testCommandProblem(argv: string[]): string | null {
  if (argv.length === 0) return "the command is empty";
  if (argv.length > MAX_ARGS) return `the command has more than ${MAX_ARGS} arguments`;
  const runner = runnerOf(argv);
  if (!runner) {
    return `\`${argv.slice(0, 3).join(" ")}\` is not an allowed test runner`;
  }
  for (const arg of argv) {
    if (arg.length === 0 || arg.length > MAX_ARG_CHARS) return "an argument is empty or too long";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
    if (/[\u0000-\u001f\u007f]/.test(arg)) return "an argument contains a control character";
    // A flag's value counts as a path too: `--config=../x`.
    for (const part of arg.split("=")) {
      if (part.startsWith("/") || part.startsWith("~")) {
        return `\`${arg}\` names a path outside the copy`;
      }
      if (part.split(/[\\/]/).includes("..")) return `\`${arg}\` climbs out of the copy`;
    }
  }
  return loadingFlagProblem(runner.family, argv, runner.prefix.length);
}

/**
 * The argv to actually start, once `testCommandProblem` has passed it.
 * `npx`/`bunx` would download a package that isn't installed, so they are
 * replaced by the copy's own `node_modules/.bin/<tool>`, which must exist and
 * stay inside the copy.
 */
export function resolveTestCommand(
  argv: string[],
  copyRoot: string,
): { argv: string[] } | { problem: string } {
  const [launcher, tool, ...rest] = argv;
  if (!launcher || !PACKAGE_LAUNCHERS.has(launcher) || !tool) return { argv };
  const root = realpathSync(copyRoot);
  const bin = join(root, "node_modules", ".bin", tool);
  try {
    lstatSync(bin);
    const target = realpathSync(bin);
    const inside = relative(root, target);
    if (inside.startsWith("..") || inside.startsWith("/")) {
      return { problem: `node_modules/.bin/${tool} leads outside the copy` };
    }
  } catch {
    return { problem: `${tool} isn't installed in the copy (no node_modules/.bin/${tool})` };
  }
  return { argv: [bin, ...rest] };
}

export interface TestCounts {
  /** Tests that ran. */
  total: number;
  failed: number;
}

const num = (match: RegExpMatchArray | null | undefined, group = 1): number | null =>
  match?.[group] === undefined ? null : Number(match[group]);

/** The last match of `pattern`, which runners print at the end. */
function last(output: string, pattern: RegExp): RegExpMatchArray | null {
  const all = [
    ...output.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)),
  ];
  return all.at(-1) ?? null;
}

const PARSERS: Record<Exclude<Family, "script">, (output: string) => TestCounts | null> = {
  bun(output) {
    const ran = num(last(output, /Ran (\d+) tests? across/));
    if (ran === null) return null;
    return { total: ran, failed: num(last(output, /^\s*(\d+) fail\b/m)) ?? 0 };
  },
  jest(output) {
    const line = last(output, /^Tests:\s+(.*?)(\d+) total/m);
    if (!line) return null;
    return { total: Number(line[2]), failed: num(/(\d+) failed/.exec(line[1] ?? "")) ?? 0 };
  },
  vitest(output) {
    const line = last(output, /^\s*Tests\s+(.*)\((\d+)\)\s*$/m);
    if (!line) return null;
    return { total: Number(line[2]), failed: num(/(\d+) failed/.exec(line[1] ?? "")) ?? 0 };
  },
  mocha(output) {
    const passing = num(last(output, /^\s*(\d+) passing/m));
    if (passing === null) return null;
    const failing = num(last(output, /^\s*(\d+) failing/m)) ?? 0;
    return { total: passing + failing, failed: failing };
  },
  node(output) {
    const total = num(last(output, /^(?:ℹ|#) tests (\d+)/m));
    if (total === null) return null;
    return { total, failed: num(last(output, /^(?:ℹ|#) fail (\d+)/m)) ?? 0 };
  },
  pytest(output) {
    // With or without the ===== rule: `-q` and some addopts print it bare.
    const line = last(output, /^(?:=+ )?(\d+ (?:passed|failed|errors?)\b.*?) in [\d.]+s/m);
    if (!line) return null;
    const count = (word: string) => num(new RegExp(`(\\d+) ${word}\\b`).exec(line[1] ?? "")) ?? 0;
    const failed = count("failed") + count("errors?");
    return { total: count("passed") + failed, failed };
  },
  go(output) {
    // Only `-v` prints a line per test.
    const passed = [...output.matchAll(/^\s*--- PASS: /gm)].length;
    const failed = [...output.matchAll(/^\s*--- FAIL: /gm)].length;
    return passed + failed > 0 ? { total: passed + failed, failed } : null;
  },
  cargo(output) {
    let total = 0;
    let failed = 0;
    let seen = false;
    for (const match of output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
      seen = true;
      total += Number(match[1]) + Number(match[2]);
      failed += Number(match[2]);
    }
    return seen ? { total, failed } : null;
  },
  rspec(output) {
    const line = last(output, /(\d+) examples?, (\d+) failures?/);
    return line ? { total: Number(line[1]), failed: Number(line[2]) } : null;
  },
  mix(output) {
    const line = last(output, /(\d+) tests?, (\d+) failures?/);
    return line ? { total: Number(line[1]), failed: Number(line[2]) } : null;
  },
  dotnet(output) {
    // One summary per test project.
    let total = 0;
    let failed = 0;
    let seen = false;
    for (const match of output.matchAll(/Failed:\s+(\d+),\s+Passed:\s+(\d+),.*?Total:\s+(\d+)/g)) {
      seen = true;
      total += Number(match[3]);
      failed += Number(match[1]);
    }
    return seen ? { total, failed } : null;
  },
};

/** How many tests a run reported, or null when its output doesn't say. */
export function parseTestCounts(argv: string[], output: string): TestCounts | null {
  const family = familyOf(argv);
  if (!family) return null;
  if (family !== "script") return PARSERS[family](output);
  for (const parse of Object.values(PARSERS)) {
    const counts = parse(output);
    if (counts) return counts;
  }
  return null;
}
