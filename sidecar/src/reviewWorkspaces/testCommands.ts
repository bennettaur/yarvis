/**
 * The test commands mutation testing may run, and how many tests each one
 * reports. The planning run proposes a command per group of test files; the
 * sidecar runs it only when it starts with one of the runners below.
 *
 * The allowlist is about what the *planner* can make the sidecar start, not
 * about the PR's code: every runner here runs code from the PR (a test file, a
 * `package.json` script), which the user consented to and the sandbox
 * contains. What it rules out is a model choosing some other program, loading
 * code from somewhere the PR didn't put it (any flag beyond a short list per
 * runner), or fetching a package (`npx` of something not installed).
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

/**
 * How a flag is used: on its own; with a value (`--flag value`, `--flag=value`,
 * or attached to a short flag, `-kfee`); either; or with one of a few values.
 */
type FlagSpec = "flag" | "value" | "optional" | readonly string[];
type FlagSet = Readonly<Record<string, FlagSpec>>;

/**
 * The flags each runner may be given, by name without dashes. Everything else
 * is refused, which is how flags that load code or configuration from a path
 * (`--require`, `--config`, `--setupFiles`, `-p` for a pytest plugin,
 * `-toolexec`, `--env-file` …) stay out without having to be listed: only test
 * selection, verbosity, timeouts, failure handling and parallelism are here.
 */
const BUN_FLAGS: FlagSet = {
  t: "value",
  "test-name-pattern": "value",
  timeout: "value",
  bail: "optional",
  only: "flag",
  todo: "flag",
  "rerun-each": "value",
};
const JEST_FLAGS: FlagSet = {
  t: "value",
  testNamePattern: "value",
  testPathPattern: "value",
  testPathIgnorePatterns: "value",
  i: "flag",
  runInBand: "flag",
  ci: "flag",
  silent: "flag",
  verbose: "flag",
  forceExit: "flag",
  detectOpenHandles: "flag",
  "no-cache": "flag",
  "no-watchman": "flag",
  bail: "optional",
  testTimeout: "value",
  maxWorkers: "value",
  w: "value",
};
const VITEST_FLAGS: FlagSet = {
  t: "value",
  testNamePattern: "value",
  bail: "value",
  testTimeout: "value",
  maxWorkers: "value",
  minWorkers: "value",
  retry: "value",
  silent: "flag",
  "no-isolate": "flag",
  "no-file-parallelism": "flag",
};
const MOCHA_FLAGS: FlagSet = {
  g: "value",
  grep: "value",
  f: "value",
  fgrep: "value",
  t: "value",
  timeout: "value",
  j: "value",
  jobs: "value",
  retries: "value",
  b: "flag",
  bail: "flag",
  exit: "flag",
  recursive: "flag",
  parallel: "flag",
  i: "flag",
  invert: "flag",
};
const NODE_FLAGS: FlagSet = {
  "test-name-pattern": "value",
  "test-skip-pattern": "value",
  "test-timeout": "value",
  "test-concurrency": "value",
  "test-only": "flag",
  "test-reporter": ["spec", "tap"],
};
const PYTEST_FLAGS: FlagSet = {
  k: "value",
  m: "value",
  maxfail: "value",
  r: "value",
  durations: "value",
  W: "value",
  timeout: "value",
  capture: ["no", "sys", "fd", "tee-sys"],
  tb: ["short", "long", "line", "no", "native", "auto"],
  x: "flag",
  exitfirst: "flag",
  q: "flag",
  quiet: "flag",
  v: "flag",
  verbose: "flag",
  s: "flag",
  l: "flag",
  showlocals: "flag",
  lf: "flag",
  "last-failed": "flag",
  ff: "flag",
  "failed-first": "flag",
  "no-header": "flag",
  "disable-warnings": "flag",
  "strict-markers": "flag",
  runxfail: "flag",
};
const GO_FLAGS: FlagSet = {
  v: "flag",
  short: "flag",
  failfast: "flag",
  race: "flag",
  run: "value",
  skip: "value",
  count: "value",
  timeout: "value",
  cpu: "value",
  parallel: "value",
  p: "value",
  tags: "value",
  shuffle: "value",
  vet: "value",
};
const CARGO_FLAGS: FlagSet = {
  lib: "flag",
  bins: "flag",
  tests: "flag",
  doc: "flag",
  release: "flag",
  q: "flag",
  quiet: "flag",
  "no-fail-fast": "flag",
  workspace: "flag",
  offline: "flag",
  locked: "flag",
  frozen: "flag",
  "all-features": "flag",
  "no-default-features": "flag",
  test: "value",
  bin: "value",
  p: "value",
  package: "value",
  features: "value",
  F: "value",
  j: "value",
  jobs: "value",
};
/** What follows `cargo test --`: the test binary's own flags. */
const CARGO_BINARY_FLAGS: FlagSet = {
  nocapture: "flag",
  exact: "flag",
  ignored: "flag",
  "include-ignored": "flag",
  q: "flag",
  quiet: "flag",
  "show-output": "flag",
  "test-threads": "value",
  skip: "value",
};
const RSPEC_FLAGS: FlagSet = {
  e: "value",
  example: "value",
  t: "value",
  tag: "value",
  order: "value",
  seed: "value",
  "fail-fast": "flag",
  "no-color": "flag",
  "only-failures": "flag",
  f: ["progress", "documentation", "p", "d"],
  format: ["progress", "documentation", "p", "d"],
};
const MIX_FLAGS: FlagSet = {
  only: "value",
  exclude: "value",
  include: "value",
  seed: "value",
  "max-failures": "value",
  "max-cases": "value",
  trace: "flag",
  failed: "flag",
  stale: "flag",
};
const DOTNET_FLAGS: FlagSet = {
  filter: "value",
  configuration: "value",
  c: "value",
  framework: "value",
  f: "value",
  verbosity: "value",
  v: "value",
  "no-build": "flag",
  "no-restore": "flag",
  nologo: "flag",
};
/** A package script's runner is unknown: what any of the node runners allows, after `--`. */
const SCRIPT_FLAGS: FlagSet = {
  ...MOCHA_FLAGS,
  ...BUN_FLAGS,
  ...VITEST_FLAGS,
  ...JEST_FLAGS,
  ...NODE_FLAGS,
};

/** Flags before and after a `--` separator. */
const FLAGS: Record<Family, { before: FlagSet; after: FlagSet }> = {
  bun: { before: BUN_FLAGS, after: {} },
  jest: { before: JEST_FLAGS, after: {} },
  vitest: { before: VITEST_FLAGS, after: {} },
  mocha: { before: MOCHA_FLAGS, after: {} },
  node: { before: NODE_FLAGS, after: {} },
  script: { before: { s: "flag", silent: "flag" }, after: SCRIPT_FLAGS },
  pytest: { before: PYTEST_FLAGS, after: {} },
  go: { before: GO_FLAGS, after: {} },
  cargo: { before: CARGO_FLAGS, after: CARGO_BINARY_FLAGS },
  rspec: { before: RSPEC_FLAGS, after: {} },
  mix: { before: MIX_FLAGS, after: {} },
  dotnet: { before: DOTNET_FLAGS, after: {} },
};

/** Families whose single-dash flags are long names (`-run`), never bundled letters. */
const SINGLE_DASH_LONG: ReadonlySet<Family> = new Set(["go"]);

/** Launchers that would fetch a package that isn't installed; run only from node_modules/.bin. */
const PACKAGE_LAUNCHERS = new Set(["npx", "bunx"]);

/**
 * Why the arguments after the runner prefix aren't allowed, or null. Arguments
 * not starting with `-` are positional (test paths, filters) and checked as
 * paths elsewhere; every flag must be on the runner's list, with a value where
 * it takes one. Bundled short flags (`-qx`, `-kfee`) are split letter by letter.
 */
function flagProblem(family: Family, argv: string[], prefixLength: number): string | null {
  const args = argv.slice(prefixLength);
  let allowed = FLAGS[family].before;
  const refuse = (arg: string) => `\`${arg}\` isn't an allowed flag for this runner`;
  const checkValue = (arg: string, spec: FlagSpec, value: string | undefined) => {
    if (spec === "flag") return value === undefined ? null : refuse(arg);
    if (value === undefined) return spec === "optional" ? null : `\`${arg}\` needs a value`;
    if (Array.isArray(spec) && !spec.includes(value)) return refuse(`${arg} ${value}`);
    return null;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      allowed = FLAGS[family].after;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    const takesNext = (spec: FlagSpec) => spec === "value" || Array.isArray(spec);
    if (arg.startsWith("--") || SINGLE_DASH_LONG.has(family)) {
      const eq = arg.indexOf("=");
      const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^-+/, "");
      const spec = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
      if (spec === undefined) return refuse(arg);
      let value = eq === -1 ? undefined : arg.slice(eq + 1);
      if (value === undefined && takesNext(spec)) value = args[++i];
      const problem = checkValue(arg, spec, value);
      if (problem) return problem;
      continue;
    }
    const letters = arg.slice(1);
    for (let j = 0; j < letters.length; j++) {
      const letter = letters[j] as string;
      const spec = Object.hasOwn(allowed, letter) ? allowed[letter] : undefined;
      if (spec === undefined) return refuse(arg);
      if (spec === "flag") continue;
      let value: string | undefined = letters.slice(j + 1).replace(/^=/, "") || undefined;
      if (value === undefined && takesNext(spec)) value = args[++i];
      const problem = checkValue(arg, spec, value);
      if (problem) return problem;
      break;
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
  return flagProblem(runner.family, argv, runner.prefix.length);
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
