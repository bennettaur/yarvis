import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  "src/linked/pricing.ts",
  "src/hard.ts",
  "test/pricing.test.ts",
  "package.json",
  "README.md",
  "src/link.ts",
  "src/missing.ts",
]);
const context = (extra: Partial<Parameters<typeof prepareEdit>[1]> = {}) => ({
  copyRoot: root,
  changedPaths: changed,
  ...extra,
});

const edit = (overrides: Partial<PlannedEdit> = {}): PlannedEdit => ({
  path: "src/pricing.ts",
  line: 3,
  oldText: "if (total >= 100) {",
  newText: "if (total > 100) {",
  description: "loosen the threshold",
  testCommandId: "unit",
  ...overrides,
});

const file = () => join(root, "src", "pricing.ts");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-mutants-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-mutants-outside-")));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(file(), SOURCE);
  writeFileSync(join(root, "test", "pricing.test.ts"), "test('x', () => {});\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "README.md"), "if (total >= 100) {\n");
  writeFileSync(join(outside, "secret.ts"), "export const x = 1;\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "src", "link.ts"));
  mkdirSync(join(outside, "dir"));
  writeFileSync(join(outside, "dir", "pricing.ts"), SOURCE);
  symlinkSync(join(outside, "dir"), join(root, "src", "linked"));
  writeFileSync(join(root, "src", "hard.ts"), SOURCE);
  linkSync(join(root, "src", "hard.ts"), join(outside, "hard-copy.ts"));
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
    ["a test file", { path: "test/pricing.test.ts" }, "test, configuration"],
    ["a config file", { path: "package.json" }, "test, configuration"],
    ["a doc", { path: "README.md", line: 1 }, "documentation"],
    ["a symlinked file", { path: "src/link.ts", oldText: "x = 1", line: 1 }, "goes through a link"],
    ["a file under a symlinked folder", { path: "src/linked/pricing.ts" }, "goes through a link"],
    ["a file with other hard links", { path: "src/hard.ts" }, "other hard links"],
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

  it("refuses an edit outside the lines the PR changed", () => {
    const ranges = new Map<string, [number, number][]>([["src/pricing.ts", [[9, 11]]]]);
    const outsideRange = prepareEdit(edit(), context({ changedRanges: ranges }));
    expect("refused" in outsideRange && outsideRange.refused).toContain("outside the lines");
    const inside = prepareEdit(
      edit({ line: 10, oldText: ">= 50", newText: "> 50" }),
      context({ changedRanges: ranges }),
    );
    expect("refused" in inside).toBe(false);
  });

  it("knows test, setup, config, docs and generated paths from source", () => {
    for (const path of [
      "src/a.test.ts",
      "src/__tests__/a.ts",
      "tests/test_a.py",
      "pkg/a_test.go",
      "spec/a_spec.rb",
      "conftest.py",
      "jest.setup.ts",
      "vitest.setup.mjs",
      "src/setupTests.ts",
      "pkg/__init__.py",
      "build.rs",
      "src/types.d.ts",
      "tsconfig.build.json",
      "vite.config.ts",
      ".github/workflows/ci.yml",
      ".eslintrc.cjs",
      "Cargo.toml",
      "docs/guide.md",
      "notes.txt",
      "vendor/lib/a.go",
      "node_modules/x/index.js",
      "api/service.pb.go",
      "proto/a_pb2.py",
      "src/schema.generated.ts",
      "public/app.min.js",
    ]) {
      expect(isTestOrConfigPath(path)).toBe(true);
    }
    for (const path of ["src/pricing.ts", "lib/attest.py", "pkg/contest.go", "src/config.ts"]) {
      expect(isTestOrConfigPath(path)).toBe(false);
    }
  });
});

describe("applying and reverting an edit", () => {
  it("has the mutant in place while the tests run, and the original bytes after", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const before = lstatSync(file()).mtimeMs;
    const during = await withEdit(prepared, async () => readFileSync(file(), "utf8"));
    expect(during).toContain("if (total > 100) {");
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
    // The mtime moves on with every write, so mtime-keyed caches see each change.
    expect(lstatSync(file()).mtimeMs).toBeGreaterThan(before);
  });

  it("restores the original when the run throws, after cleaning up", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const order: string[] = [];
    await expect(
      withEdit(
        prepared,
        async () => {
          order.push("run");
          throw new Error("runner broke");
        },
        async () => {
          order.push("clean up");
        },
      ),
    ).rejects.toThrow("runner broke");
    expect(order).toEqual(["run", "clean up"]);
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
  });

  it("refuses to start from a file that changed since it was checked", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    writeFileSync(file(), `${SOURCE}// edited by a test\n`);
    await expect(withEdit(prepared, async () => "ran")).rejects.toBeInstanceOf(RevertError);
  });

  it("won't write through a symlink the tests put in the file's place", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const target = join(outside, "target.ts");
    writeFileSync(target, "outside\n");
    const run = withEdit(prepared, async () => {
      rmSync(file());
      symlinkSync(target, file());
    });
    await expect(run).rejects.toThrow(RevertError);
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });

  it("won't write through a hard link the tests made to the file", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const run = withEdit(prepared, async () => {
      linkSync(file(), join(outside, "grabbed.ts"));
    });
    await expect(run).rejects.toThrow("hard-linked");
    // The outside link still holds the mutant; nothing was written through it.
    expect(readFileSync(join(outside, "grabbed.ts"), "utf8")).toContain("total > 100");
  });

  it("won't write when the tests swapped the file's folder for a link", async () => {
    const prepared = prepareEdit(edit(), context()) as ValidEdit;
    const run = withEdit(prepared, async () => {
      renameSync(join(root, "src"), join(root, "src-moved"));
      symlinkSync(join(outside, "dir"), join(root, "src"));
    });
    await expect(run).rejects.toThrow(RevertError);
    expect(readFileSync(join(outside, "dir", "pricing.ts"), "utf8")).toBe(SOURCE);
  });
});

describe("the plan schema", () => {
  const plan = {
    testCommands: [{ id: "unit", argv: ["bun", "test", "test/pricing.test.ts"], testFiles: [] }],
    positiveControls: [{ ...edit(), newText: "if (false) {" }],
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

  it("bounds the lists, the edit sizes and the ids, and refuses duplicate or reserved ids", () => {
    const bad = [
      { ...plan, mutants: Array(41).fill(plan.mutants[0]) },
      { ...plan, testCommands: Array(11).fill(plan.testCommands[0]) },
      { ...plan, positiveControls: Array(11).fill(plan.positiveControls[0]) },
      { ...plan, testCommands: [{ ...plan.testCommands[0], argv: [] }] },
      { ...plan, mutants: [{ ...plan.mutants[0], oldText: "" }] },
      { ...plan, mutants: [{ ...plan.mutants[0], oldText: "x".repeat(2_001) }] },
      { ...plan, mutants: [{ ...plan.mutants[0], id: "has space" }] },
      { ...plan, mutants: [{ ...plan.mutants[0], line: 0 }] },
      { ...plan, mutants: [{ ...plan.mutants[0], testFiles: Array(21).fill("t") }] },
      { ...plan, mutants: [plan.mutants[0], plan.mutants[0]] },
      { ...plan, testCommands: [plan.testCommands[0], plan.testCommands[0]] },
      { ...plan, mutants: [{ ...plan.mutants[0], id: "control-unit" }] },
    ];
    for (const value of bad) expect(mutationPlanSchema.safeParse(value).success).toBe(false);
  });
});
