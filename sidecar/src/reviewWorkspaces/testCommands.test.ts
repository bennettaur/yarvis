import { describe, expect, it } from "bun:test";
import { parseTestCounts, testCommandProblem } from "./testCommands.ts";

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
      "Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3",
      { total: 3, failed: 0 },
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
