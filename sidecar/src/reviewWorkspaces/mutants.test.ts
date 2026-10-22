import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isTestOrConfigPath,
  mutationPlanSchema,
  type PlannedEdit,
  prepareEdit,
  RevertError,
  type ValidEdit,
  withEdit,
} from "./mutants.ts";

const SOURCE = `export function discountedTotal(total: number, isMember: boolean): number {
  if (total < 0) throw new Error("negative");
  if (total >= 100) {
    return isMember ? total * 0.8 : total * 0.9;
  }
  return total;
}

export function shippingFee(total: number): number {
  return total >= 50 ? 0 : 5;
}
`;

let root: string;
let outside: string;
const changed = new Set([
  "src/pricing.ts",
  "test/pricing.test.ts",
  "package.json",
  "src/link.ts",
  "src/missing.ts",
]);
const context = () => ({ copyRoot: root, changedPaths: changed });

const edit = (overrides: Partial<PlannedEdit> = {}): PlannedEdit => ({
  path: "src/pricing.ts",
  line: 3,
  oldText: "if (total >= 100) {",
  newText: "if (total > 100) {",
  description: "loosen the threshold",
  testCommandId: "unit",
  ...overrides,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-mutants-"));
  outside = mkdtempSync(join(tmpdir(), "yarvis-mutants-outside-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "pricing.ts"), SOURCE);
  writeFileSync(join(root, "test", "pricing.test.ts"), "test('x', () => {});\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(outside, "secret.ts"), "export const x = 1;\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "link.ts"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("checking a proposed edit", () => {
  it("builds the mutated file for an edit at the named place", () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    expect(prepared.original.toString()).toBe(SOURCE);
    expect(prepared.mutated.toString()).toBe(
      SOURCE.replace("if (total >= 100) {", "if (total > 100) {"),
    );
  });

  it("finds a short snippet when it is unique near the line, even if it recurs elsewhere", () => {
    const prepared = prepareEdit(edit({ line: 10, oldText: ">= 50", newText: "> 50" }), context());
    expect("refused" in prepared).toBe(false);
  });

  const refusals: [string, Partial<PlannedEdit>, string][] = [
    ["a path that climbs out", { path: "../x.ts" }, ""],
    ["an absolute path", { path: "/etc/hosts" }, ""],
    [
      "a file the PR doesn't change",
      { path: "src/other.ts" },
      "not a file this pull request changes",
    ],
    ["a test file", { path: "test/pricing.test.ts" }, "test or configuration"],
    ["a config file", { path: "package.json" }, "test or configuration"],
    [
      "a symlink out of the copy",
      { path: "src/link.ts", oldText: "x = 1", line: 1 },
      "outside the copy",
    ],
    ["a file that isn't there", { path: "src/missing.ts" }, "does not exist"],
    ["text that isn't in the file", { oldText: "total >= 1000" }, "isn't near line 3"],
    ["text far from the named line", { line: 9 }, "isn't near line 9"],
    ["text that recurs near the line", { line: 2, oldText: "total" }, "occurs"],
    ["an edit that changes nothing", { newText: "if (total >= 100) {" }, "changes nothing"],
  ];
  for (const [what, change, reason] of refusals) {
    it(`refuses ${what}`, () => {
      const prepared = prepareEdit(edit(change), context());
      expect("refused" in prepared).toBe(true);
      if ("refused" in prepared) expect(prepared.refused).toContain(reason);
    });
  }

  it("knows test and configuration paths from source", () => {
    for (const path of [
      "src/a.test.ts",
      "src/__tests__/a.ts",
      "tests/test_a.py",
      "pkg/a_test.go",
      "spec/a_spec.rb",
      "conftest.py",
      "tsconfig.build.json",
      "vite.config.ts",
      ".github/workflows/ci.yml",
      ".eslintrc.cjs",
      "Cargo.toml",
    ]) {
      expect(isTestOrConfigPath(path)).toBe(true);
    }
    for (const path of ["src/pricing.ts", "lib/attest.py", "pkg/contest.go", "src/config.ts"]) {
      expect(isTestOrConfigPath(path)).toBe(false);
    }
  });
});

describe("applying and reverting an edit", () => {
  const file = () => join(root, "src", "pricing.ts");

  it("has the mutant in place while the tests run, and the original bytes after", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const during = await withEdit(prepared, async () => readFileSync(file(), "utf8"));
    expect(during).toContain("if (total > 100) {");
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
  });

  it("restores the original when the run throws", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    await expect(
      withEdit(prepared, async () => {
        throw new Error("runner broke");
      }),
    ).rejects.toThrow("runner broke");
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
  });

  it("refuses to start from a file that changed since it was checked", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    writeFileSync(file(), `${SOURCE}// edited by a test\n`);
    await expect(withEdit(prepared, async () => "ran")).rejects.toBeInstanceOf(RevertError);
  });

  it("reports a restore that doesn't hold", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    // A file the restore can't bring back: the path now names a directory.
    const run = withEdit(prepared, async () => {
      rmSync(file());
      mkdirSync(file());
    });
    await expect(run).rejects.toThrow();
  });
});

describe("the plan schema", () => {
  const plan = {
    testCommands: [{ id: "unit", argv: ["bun", "test", "test/pricing.test.ts"], testFiles: [] }],
    positiveControl: { ...edit(), newText: "if (false) {" },
    mutants: [
      {
        ...edit(),
        id: "m1",
        rationale: "boundary",
        testFiles: ["test/pricing.test.ts"],
        likelyEquivalent: false,
      },
    ],
    notes: "",
  };

  it("accepts a well-formed plan", () => {
    expect(mutationPlanSchema.parse(plan)).toEqual(plan);
  });

  it("bounds the lists, the edit sizes and the ids", () => {
    const bad = [
      { ...plan, mutants: Array(41).fill(plan.mutants[0]) },
      { ...plan, testCommands: Array(11).fill(plan.testCommands[0]) },
      { ...plan, testCommands: [{ ...plan.testCommands[0], argv: [] }] },
      { ...plan, mutants: [{ ...plan.mutants[0], oldText: "" }] },
      { ...plan, mutants: [{ ...plan.mutants[0], oldText: "x".repeat(2_001) }] },
      { ...plan, mutants: [{ ...plan.mutants[0], id: "has space" }] },
      { ...plan, mutants: [{ ...plan.mutants[0], line: 0 }] },
      { ...plan, mutants: [{ ...plan.mutants[0], testFiles: Array(21).fill("t") }] },
    ];
    for (const value of bad) expect(mutationPlanSchema.safeParse(value).success).toBe(false);
  });
});
