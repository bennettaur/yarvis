import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestCounts, resolveTestCommand, testCommandProblem } from "./testCommands.ts";

describe("which test commands may run", () => {
  it("allows the listed runners with relative paths, flags and filters", () => {
    for (const argv of [
      ["bun", "test", "test/pricing.test.ts"],
      ["npx", "vitest", "run", "src/a.test.ts", "-t", "discount applies"],
      ["python3", "-m", "pytest", "tests/test_a.py::test_b", "-q"],
      ["go", "test", "-v", "./pricing/..."],
      ["npm", "test", "--", "--runInBand"],
      ["cargo", "test", "discount"],
    ]) {
      expect(testCommandProblem(argv)).toBeNull();
    }
  });

  it("refuses other programs, paths out of the copy and control characters", () => {
    const refused: [string[], string][] = [
      [[], "empty"],
      [["sh", "-c", "bun test"], "not an allowed test runner"],
      [["bun", "install"], "not an allowed test runner"],
      [["bunx", "cowsay"], "not an allowed test runner"],
      [["git", "push"], "not an allowed test runner"],
      [["bun", "test", "/etc/passwd"], "outside the copy"],
      [["bun", "test", "~/.ssh/id_rsa"], "outside the copy"],
      [["bun", "test", "../other/test.ts"], "climbs out"],
      [["npx", "vitest", "--config=../evil.ts"], "climbs out"],
      [["npx", "jest", "--rootDir=/"], "outside the copy"],
      [["bun", "test", "a\nb"], "control character"],
      [["bun", "test", ""], "empty or too long"],
      [["bun", "test", "x".repeat(301)], "empty or too long"],
      [["bun", "test", ...Array(39).fill("a")], "more than 40"],
    ];
    for (const [argv, problem] of refused) expect(testCommandProblem(argv)).toContain(problem);
  });
});

describe("flags beyond each runner's list", () => {
  const refused: string[][] = [
    ["bun", "test", "--preload", "./x.ts"],
    ["bun", "test", "-r", "./x.ts"],
    ["node", "--test", "--require", "./x.js"],
    ["node", "--test", "--import=./x.mjs"],
    ["node", "--test", "--loader", "./x.mjs"],
    ["node", "--test", "-e", "1"],
    ["node", "--test", "--test-reporter=./r.mjs"],
    ["npx", "jest", "--config", "jest.config.js"],
    ["npx", "jest", "-c", "x.js"],
    ["npx", "jest", "--setupFiles=./s.js"],
    ["npx", "jest", "--testEnvironment", "./env.js"],
    ["npx", "jest", "--reporters=./r.js"],
    ["npx", "vitest", "run", "--config=v.ts"],
    ["npx", "vitest", "run", "--reporter", "./r.ts"],
    ["npx", "mocha", "--require", "./x.js"],
    ["npx", "mocha", "-rsetup.js"],
    ["npm", "test", "--script-shell=./sh"],
    ["npm", "test", "--userconfig", "./npmrc"],
    ["npm", "test", "--", "--require", "./x.js"],
    ["pytest", "-p", "evil_plugin"],
    ["pytest", "-pevil_plugin"],
    ["pytest", "-c", "other.ini"],
    ["pytest", "-o", "addopts=-p evil"],
    ["python3", "-m", "pytest", "--confcutdir", "."],
    ["go", "test", "-exec", "./wrapper"],
    ["go", "test", "-toolexec=./wrapper"],
    ["go", "test", "-overlay", "o.json"],
    ["cargo", "test", "--config", "target.x.runner='./r'"],
    ["cargo", "test", "-Z", "unstable-options"],
    ["rspec", "-r", "./x.rb"],
    ["dotnet", "test", "--logger", "x"],
    ["dotnet", "test", "--collect", "x"],
    ["dotnet", "test", "--test-adapter-path", "."],
    ["node", "--test", "--env-file=.env"],
    ["npx", "jest", "--moduleDirectories", "x"],
    ["npx", "vitest", "run", "--pool", "./pool.js"],
    ["pytest", "-qp", "evil"],
    ["pytest", "--tb=evil"],
    ["node", "--test", "--test-reporter", "./r.mjs"],
    ["bun", "test", "--bail=2", "--coverage"],
  ];
  for (const argv of refused) {
    it(`refuses ${argv.join(" ")}`, () => {
      expect(testCommandProblem(argv)).toContain("isn't an allowed flag");
    });
  }

  it("keeps the ordinary filters and switches, bundled or not", () => {
    for (const argv of [
      ["pytest", "-qx", "-kfee", "--tb=short", "-vv", "--maxfail", "2"],
      ["node", "--test", "--test-reporter=spec", "--test-name-pattern", "fee", "node/"],
      ["npm", "test", "--", "-t", "fee", "--runInBand"],
      ["cargo", "test", "--lib", "fee", "--", "--nocapture", "--test-threads=1"],
      ["bun", "test", "--bail", "--timeout", "5000"],
      ["go", "test", "-v", "-run", "TestFee", "-count=1", "./..."],
      ["pytest", "-q", "-x", "-k", "fee", "-rA"],
      ["npx", "jest", "-t", "fee", "--runInBand"],
      ["bun", "test", "-t", "fee"],
    ]) {
      expect(testCommandProblem(argv)).toBeNull();
    }
  });
});

describe("flag values", () => {
  it("needs a value where a flag takes one, and refuses one where it doesn't", () => {
    expect(testCommandProblem(["pytest", "-k"])).toContain("needs a value");
    expect(testCommandProblem(["go", "test", "-v=true"])).toContain("isn't an allowed flag");
    expect(testCommandProblem(["npx", "jest", "--ci=false"])).toContain("isn't an allowed flag");
  });
});

describe("running npx and bunx without fetching", () => {
  let copy: string;
  beforeEach(() => {
    copy = mkdtempSync(join(tmpdir(), "yarvis-resolve-"));
    mkdirSync(join(copy, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(copy, "node_modules", "vitest", "cli.js"), "");
    mkdirSync(join(copy, "node_modules", ".bin"));
    symlinkSync("../vitest/cli.js", join(copy, "node_modules", ".bin", "vitest"));
    symlinkSync("/usr/bin/true", join(copy, "node_modules", ".bin", "escape"));
  });
  afterEach(() => rmSync(copy, { recursive: true, force: true }));

  it("runs an installed tool straight from node_modules/.bin", () => {
    const resolved = resolveTestCommand(["npx", "vitest", "run", "a.test.ts"], copy);
    expect(resolved).toEqual({
      argv: [join(realpathSync(copy), "node_modules", ".bin", "vitest"), "run", "a.test.ts"],
    });
  });

  it("refuses a tool that isn't installed, or whose link leaves the copy", () => {
    expect(resolveTestCommand(["npx", "jest"], copy)).toEqual({
      problem: expect.stringContaining("isn't installed"),
    });
    expect(resolveTestCommand(["bunx", "escape"], copy)).toEqual({
      problem: expect.stringContaining("outside the copy"),
    });
  });

  it("leaves other runners alone", () => {
    expect(resolveTestCommand(["bun", "test"], copy)).toEqual({ argv: ["bun", "test"] });
  });
});

describe("counting tests from runner output", () => {
  const cases: [string[], string, { total: number; failed: number } | null][] = [
    [
      ["bun", "test"],
      " 2 pass\n 1 fail\n 4 expect() calls\nRan 3 tests across 1 file. [5.00ms]",
      { total: 3, failed: 1 },
    ],
    [["bun", "test"], " 3 pass\n 0 fail\nRan 3 tests across 1 file.", { total: 3, failed: 0 }],
    [["npx", "jest"], "Tests:       1 failed, 3 passed, 4 total\n", { total: 4, failed: 1 }],
    [["npx", "vitest", "run"], " Tests  1 failed | 2 passed (3)\n", { total: 3, failed: 1 }],
    [["npx", "vitest"], "      Tests  5 passed (5)\n", { total: 5, failed: 0 }],
    [["npx", "mocha"], "  4 passing (12ms)\n  2 failing\n", { total: 6, failed: 2 }],
    [["node", "--test"], "ℹ tests 3\nℹ pass 3\nℹ fail 0\n", { total: 3, failed: 0 }],
    [["pytest"], "======= 1 failed, 4 passed in 0.12s =======\n", { total: 5, failed: 1 }],
    [["pytest"], "==== 2 passed, 1 error in 0.30s ====", { total: 3, failed: 1 }],
    [["pytest", "-q"], ".F.\n1 failed, 2 passed in 0.05s\n", { total: 3, failed: 1 }],
    [["pytest", "-q"], "...\n3 passed in 0.12s\n", { total: 3, failed: 0 }],
    [
      ["go", "test", "-v"],
      "=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\nFAIL\n",
      { total: 2, failed: 1 },
    ],
    [["go", "test"], "ok  \texample.com/p\t0.01s\n", null],
    [
      ["cargo", "test"],
      "test result: ok. 3 passed; 0 failed; 0 ignored\ntest result: FAILED. 1 passed; 1 failed;",
      { total: 5, failed: 1 },
    ],
    [["rspec"], "6 examples, 2 failures\n", { total: 6, failed: 2 }],
    [["mix", "test"], "4 tests, 0 failures\n", { total: 4, failed: 0 }],
    [
      ["dotnet", "test"],
      "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3\nFailed!  - Failed:     1, Passed:     1, Skipped:     0, Total:     2",
      { total: 5, failed: 1 },
    ],
    // A package script: whichever runner's summary it printed.
    [
      ["npm", "test"],
      "> bun test\n 1 pass\n 0 fail\nRan 1 tests across 1 file.",
      { total: 1, failed: 0 },
    ],
    [["npm", "test"], "Error: Cannot find module 'x'\n", null],
  ];
  for (const [argv, output, expected] of cases) {
    it(`reads ${argv.join(" ")}${expected ? "" : " (no count)"}`, () => {
      expect(parseTestCounts(argv, output)).toEqual(expected);
    });
  }
});
