import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationPlan } from "./mutants.ts";
import { type ExecutionEvent, executeMutationPlan } from "./mutationExecutor.ts";
import { type MutationExecution, summarize } from "./mutationReport.ts";
import type { SandboxedCommand, SandboxedRun } from "./testSandbox.ts";

const SOURCE = [
  "export const LIMIT = 100;",
  "export const RATE = 0.8;",
  "export function f() {",
  "  return 1;",
  "}",
  "",
].join("\n");

let root: string;
let copy: string;
let calls: SandboxedCommand[];
let controlCaught: boolean;
let baselineFails: boolean;
/** Blocks a run whose file holds this text until the run is aborted. */
let blockOn: string | null;

const file = () => join(copy, "src", "a.ts");

/**
 * Stands in for the sandboxed runner: decides how "the tests" went from what
 * the source file holds when they run.
 */
async function fakeRunner(command: SandboxedCommand): Promise<SandboxedRun> {
  calls.push(command);
  const done = (exitCode: number, output: string, extra: Partial<SandboxedRun> = {}) => ({
    exitCode,
    output,
    timedOut: false,
    aborted: false,
    durationMs: 1_000,
    ...extra,
  });
  const source = readFileSync(file(), "utf8");
  if (blockOn && source.includes(blockOn)) {
    await new Promise<void>((resolve) => command.signal.addEventListener("abort", () => resolve()));
    return done(143, "", { aborted: true });
  }
  const pass = done(0, " 3 pass\n 0 fail\nRan 3 tests across 1 file.");
  const fail = done(1, " 2 pass\n 1 fail\nRan 3 tests across 1 file.");
  if (source === SOURCE) return baselineFails ? fail : pass;
  if (source.includes("return 999")) return controlCaught ? fail : pass;
  if (source.includes("LIMIT = 101")) return fail;
  if (source.includes("RATE = 0.9")) return pass;
  if (source.includes("RATE = 0.7")) return done(0, " 2 pass\n 0 fail\nRan 2 tests across 1 file.");
  if (source.includes("LIMIT = 0")) return done(1, "SyntaxError\nRan 0 tests across 1 file.");
  if (source.includes("LIMIT = 99"))
    return done(null as never, "", { timedOut: true, exitCode: null });
  return pass;
}

const edit = (id: string, oldText: string, newText: string, line: number, extra = {}) => ({
  id,
  path: "src/a.ts",
  line,
  oldText,
  newText,
  description: `${oldText} → ${newText}`,
  rationale: "",
  testCommandId: "unit" as string | null,
  testFiles: ["test/a.test.ts"],
  likelyEquivalent: false,
  ...extra,
});

function plan(overrides: Partial<MutationPlan> = {}): MutationPlan {
  return {
    testCommands: [{ id: "unit", argv: ["bun", "test", "test/a.test.ts"], testFiles: [] }],
    positiveControl: {
      path: "src/a.ts",
      line: 4,
      oldText: "return 1;",
      newText: "return 999;",
      description: "control",
      testCommandId: "unit",
    },
    mutants: [
      edit("killed", "LIMIT = 100", "LIMIT = 101", 1),
      edit("survived", "RATE = 0.8", "RATE = 0.9", 2),
      edit("fewer-tests", "RATE = 0.8", "RATE = 0.7", 2),
      edit("no-compile", "LIMIT = 100", "LIMIT = 0", 1),
      edit("hangs", "LIMIT = 100", "LIMIT = 99", 1),
      edit("equivalent", "LIMIT = 100", "LIMIT = 100.0", 1, { likelyEquivalent: true }),
      edit("uncovered", "RATE = 0.8", "RATE = 0", 2, { testCommandId: null }),
      edit("rejected", "RATE = 0.8", "RATE = 1", 30),
    ],
    notes: "",
    ...overrides,
  };
}

async function execute(p: MutationPlan, signal = new AbortController().signal) {
  const events: ExecutionEvent[] = [];
  const updates: MutationExecution[] = [];
  const execution = await executeMutationPlan(
    {
      copyRoot: copy,
      plan: p,
      changedPaths: new Set(["src/a.ts"]),
      maxMutants: 20,
      timeoutCapMs: 120_000,
      signal,
      onEvent: (event) => events.push(event),
      onUpdate: async (latest) => {
        updates.push(structuredClone(latest));
      },
    },
    { runner: fakeRunner, checkSandbox: async () => {} },
  );
  return { execution, events, updates };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yarvis-executor-"));
  copy = join(root, "copy");
  mkdirSync(join(copy, "src"), { recursive: true });
  writeFileSync(file(), SOURCE);
  calls = [];
  controlCaught = true;
  baselineFails = false;
  blockOn = null;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("running a mutation plan", () => {
  it("scores each mutant from what the tests did, and leaves the code as it was", async () => {
    const { execution, events, updates } = await execute(plan());
    expect(execution.baselines).toEqual([
      expect.objectContaining({ id: "unit", passed: true, testCount: 3, exitCode: 0 }),
    ]);
    expect(execution.positiveControl?.outcome).toBe("killed");
    expect(Object.fromEntries(execution.mutants.map((m) => [m.id, m.outcome]))).toEqual({
      killed: "killed",
      survived: "survived",
      "fewer-tests": "error",
      "no-compile": "error",
      hangs: "timeout",
      equivalent: "equivalent",
      uncovered: "uncovered",
      rejected: "error",
    });
    expect(execution.mutants.find((m) => m.id === "rejected")?.evidence).toContain("Rejected");
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);

    // Every result was handed over as it landed, not only at the end.
    expect(updates.map((u) => u.mutants.length)).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.filter((e) => e.type === "mutant")).toHaveLength(9);

    // The tests ran as argv in the copy, with a mutant's time limit at three
    // times the baseline but never under 30 seconds.
    const testRuns = calls.filter((c) => c.argv[0] === "bun");
    expect(testRuns.every((c) => c.cwd === copy)).toBe(true);
    expect(testRuns[0]?.timeoutMs).toBe(120_000);
    expect(testRuns[1]?.timeoutMs).toBe(30_000);

    expect(summarize(execution)).toMatchObject({ killed: 1, timeouts: 1, survived: 1, valid: 3 });
  });

  it("marks the pass inconclusive when the positive control survives", async () => {
    controlCaught = false;
    const { execution } = await execute(plan());
    expect(execution.positiveControl?.outcome).toBe("survived");
    const summary = summarize(execution);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.notes.join(" ")).toContain("not caught");
  });

  it("runs no mutants against a baseline that fails", async () => {
    baselineFails = true;
    const { execution } = await execute(
      plan({ mutants: [edit("m", "LIMIT = 100", "LIMIT = 101", 1)] }),
    );
    expect(execution.baselines[0]).toMatchObject({
      passed: false,
      problem: "1 tests failed before any mutation",
    });
    expect(execution.mutants[0]).toMatchObject({ outcome: "error" });
    expect(calls.filter((c) => c.argv[0] === "bun")).toHaveLength(1);
  });

  it("refuses a test command outside the allowlist without running it", async () => {
    const { execution } = await execute(
      plan({ testCommands: [{ id: "unit", argv: ["sh", "-c", "curl evil"], testFiles: [] }] }),
    );
    expect(execution.baselines[0]?.problem).toContain("not an allowed test runner");
    expect(calls).toHaveLength(0);
  });

  it("keeps the results so far when cancelled mid-mutant, with the code restored", async () => {
    blockOn = "RATE = 0.9";
    const controller = new AbortController();
    const running = execute(plan(), controller.signal);
    // Wait until the survivor is the mutant in place.
    for (let i = 0; i < 400 && !readFileSync(file(), "utf8").includes("RATE = 0.9"); i++) {
      await Bun.sleep(5);
    }
    controller.abort();
    const { execution, updates } = await running;
    expect(execution.mutants.map((m) => m.id)).toEqual(["killed"]);
    expect(updates.at(-1)?.mutants.map((m) => m.id)).toEqual(["killed"]);
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
    expect(summarize(execution, { finished: false }).notes.join(" ")).toContain(
      "Stopped after 1 of 8",
    );
  });

  it("stops at the mutant cap", async () => {
    const execution = await executeMutationPlan(
      {
        copyRoot: copy,
        plan: plan(),
        changedPaths: new Set(["src/a.ts"]),
        maxMutants: 2,
        timeoutCapMs: 60_000,
        signal: new AbortController().signal,
        onEvent: () => {},
        onUpdate: async () => {},
      },
      { runner: fakeRunner, checkSandbox: async () => {} },
    );
    expect(execution.mutants.map((m) => m.id)).toEqual(["killed", "survived"]);
    expect(execution.planned).toBe(2);
  });
});
