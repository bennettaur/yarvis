/**
 * The test commands mutation testing may run, and how many tests each one
 * reports. The planning run proposes a command per group of test files; the
 * sidecar runs it only when it starts with one of the runners below.
 *
 * The allowlist is about what the *planner* can make the sidecar start, not
 * about the PR's code: every runner here runs code from the PR (a test file, a
 * `package.json` script), which the user consented to and the sandbox
 * contains. What it rules out is a model choosing some other program.
 */

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

function familyOf(argv: string[]): Family | null {
  // Longest prefix first, so `bun run test` isn't read as `bun …`.
  const matches = RUNNERS.filter(
    (runner) =>
      runner.prefix.length <= argv.length && runner.prefix.every((part, i) => argv[i] === part),
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  return matches[0]?.family ?? null;
}

/**
 * Why `argv` may not run, or null when it may. Beyond the runner prefix, each
 * argument must be a plain relative path, flag or filter: nothing absolute or
 * home-relative, no `..`, no control characters. No shell ever sees it.
 */
export function testCommandProblem(argv: string[]): string | null {
  if (argv.length === 0) return "the command is empty";
  if (argv.length > MAX_ARGS) return `the command has more than ${MAX_ARGS} arguments`;
  if (!familyOf(argv)) {
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
  return null;
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
    const line = last(output, /^=+ (.*\d+ (?:passed|failed|errors?)\b.*) in [\d.]+s/m);
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
    const line = last(output, /Failed:\s+(\d+),\s+Passed:\s+(\d+),.*?Total:\s+(\d+)/);
    return line ? { total: Number(line[3]), failed: Number(line[1]) } : null;
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
