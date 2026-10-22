import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MutationPlan, RevertError } from "./mutants.ts";
import { classify, type ExecutionEvent, executeMutationPlan } from "./mutationExecutor.ts";
import { type MutationExecution, summarize } from "./mutationReport.ts";
import type { SandboxedCommand, SandboxedRun } from "./testSandbox.ts";

const SOURCE = [
  "export const LIMIT = 100;",
  "export const RATE = 0.8;",
  "export function f() {",
  "  return 1;",
  "}",
  "export function g() {",
  "  return 2;",
  "}",
  "",
].join("\n");

let root: string;
let copy: string;
let calls: SandboxedCommand[];
let strayChecks: number;
/** Sources whose tests "fail", per command (by the last argv entry). */
let caughtBy: Record<string, string[]>;
let baselineFails: boolean;
/** Blocks a run whose file holds this text until the run is aborted. */
let blockOn: string | null;
let onRun: ((command: SandboxedCommand) => void) | null;

const file = () => join(copy, "src", "a.ts");

const done = (exitCode: number | null, output: string, extra: Partial<SandboxedRun> = {}) => ({
  exitCode,
  output,
  timedOut: false,
  aborted: false,
  durationMs: 1_000,
  ...extra,
});
const PASS = " 3 pass\n 0 fail\nRan 3 tests across 1 file.";
const FAIL = " 2 pass\n 1 fail\nRan 3 tests across 1 file.";

/**
 * Stands in for the sandboxed runner: decides how "the tests" went from what
 * the source file holds when they run, and which command ran.
 */
async function fakeRunner(command: SandboxedCommand): Promise<SandboxedRun> {
  calls.push(command);
  onRun?.(command);
  const source = readFileSync(file(), "utf8");
  if (blockOn && source.includes(blockOn)) {
    await new Promise<void>((resolve) => command.signal.addEventListener("abort", () => resolve()));
    return done(143, "", { aborted: true });
  }
  const which = command.argv.at(-1) as string;
  if (source === SOURCE) return done(baselineFails ? 1 : 0, baselineFails ? FAIL : PASS);
  if ((caughtBy[which] ?? []).some((text) => source.includes(text))) return done(1, FAIL);
  if (source.includes("RATE = 0.7")) return done(0, " 2 pass\n 0 fail\nRan 2 tests across 1 file.");
  if (source.includes("LIMIT = 0")) return done(1, "SyntaxError\nRan 0 tests across 1 file.");
  if (source.includes("LIMIT = 99")) return done(null, "", { timedOut: true });
  return done(0, PASS);
}

const mutant = (id: string, oldText: string, newText: string, line: number, extra = {}) => ({
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

const control = (testCommandId: string | null, line = 4, oldText = "return 1;") => ({
  path: "src/a.ts",
  line,
  oldText,
  newText: "return 999;",
  description: "control",
  testCommandId,
});

function plan(overrides: Partial<MutationPlan> = {}): MutationPlan {
  return {
    testCommands: [{ id: "unit", argv: ["bun", "test", "unit"], testFiles: [] }],
    positiveControls: [control("unit")],
    mutants: [
      mutant("killed", "LIMIT = 100", "LIMIT = 101", 1),
      mutant("survived", "RATE = 0.8", "RATE = 0.9", 2),
      mutant("fewer-tests", "RATE = 0.8", "RATE = 0.7", 2),
      mutant("no-compile", "LIMIT = 100", "LIMIT = 0", 1),
      mutant("hangs", "LIMIT = 100", "LIMIT = 99", 1),
      mutant("equivalent", "LIMIT = 100", "LIMIT = 100.0", 1, { likelyEquivalent: true }),
      mutant("uncovered", "RATE = 0.8", "RATE = 0", 2, { testCommandId: null }),
      mutant("covered-after-all", "return 2;", "return 3;", 7, { testCommandId: null }),
      mutant("rejected", "RATE = 0.8", "RATE = 1", 30),
    ],
    notes: "",
    ...overrides,
  };
}

async function execute(p: MutationPlan, signal = new AbortController().signal, maxMutants = 20) {
  const events: ExecutionEvent[] = [];
  const updates: MutationExecution[] = [];
  const execution = await executeMutationPlan(
    {
      copyRoot: copy,
      plan: p,
      changedPaths: new Set(["src/a.ts"]),
      maxMutants,
      timeoutCapMs: 120_000,
      signal,
      onEvent: (event) => events.push(event),
      onUpdate: async (latest) => {
        updates.push(structuredClone(latest));
      },
    },
    {
      runner: fakeRunner,
      checkSandbox: async () => {},
      killStrays: async () => {
        strayChecks++;
        return [];
      },
      makeTempDir: () => mkdtempSync(join(root, "tmp-")),
    },
  );
  return { execution, events, updates };
}

const outcomes = (execution: MutationExecution) =>
  Object.fromEntries(execution.mutants.map((m) => [m.id, m.outcome]));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "yarvis-executor-")));
  copy = join(root, "copy");
  mkdirSync(join(copy, "src"), { recursive: true });
  writeFileSync(file(), SOURCE);
  calls = [];
  strayChecks = 0;
  caughtBy = { unit: ["return 999", "LIMIT = 101", "return 3"] };
  baselineFails = false;
  blockOn = null;
  onRun = null;
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
    expect(execution.positiveControls.map((c) => [c.id, c.outcome])).toEqual([
      ["control-unit", "killed"],
    ]);
    expect(outcomes(execution)).toEqual({
      killed: "killed",
      survived: "survived",
      "fewer-tests": "error",
      "no-compile": "error",
      hangs: "timeout",
      uncovered: "uncovered",
      "covered-after-all": "killed",
      rejected: "error",
      equivalent: "equivalent",
    });
    const byId = new Map(execution.mutants.map((m) => [m.id, m]));
    expect(byId.get("rejected")?.evidence).toContain("Rejected");
    expect(byId.get("covered-after-all")?.evidence).toContain("`unit` caught it");
    expect(byId.get("no-compile")?.evidence).toContain("exited with code 1 after 0 tests");
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);

    // Every result was handed over as it landed, not only at the end.
    expect(updates.map((u) => u.mutants.length)).toEqual([0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.filter((e) => e.type === "mutant")).toHaveLength(10);

    // A mutant's time limit is three times the baseline but never under 30 seconds.
    expect(calls[0]?.timeoutMs).toBe(120_000);
    expect(calls[1]?.timeoutMs).toBe(30_000);
    // Leftovers were looked for after every test run.
    expect(strayChecks).toBeGreaterThanOrEqual(calls.length);

    expect(summarize(execution)).toMatchObject({ killed: 2, timeouts: 1, survived: 1, valid: 4 });
  });

  it("leaves a command's mutants unscored when its positive control survives", async () => {
    caughtBy = { unit: ["LIMIT = 101"] };
    const { execution } = await execute(plan());
    expect(execution.positiveControls[0]?.outcome).toBe("survived");
    expect(execution.mutants.find((m) => m.id === "killed")).toMatchObject({
      outcome: "error",
      evidence: expect.stringContaining("positive control"),
    });
    const summary = summarize(execution);
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.notes.join(" ")).toContain("not caught");
  });

  it("scores each command against its own control", async () => {
    caughtBy = { unit: ["return 999", "LIMIT = 101"], e2e: ["LIMIT = 101"] };
    const { execution } = await execute(
      plan({
        testCommands: [
          { id: "unit", argv: ["bun", "test", "unit"], testFiles: [] },
          { id: "e2e", argv: ["bun", "test", "e2e"], testFiles: [] },
        ],
        positiveControls: [control("unit"), control("e2e")],
        mutants: [
          mutant("via-unit", "LIMIT = 100", "LIMIT = 101", 1),
          mutant("via-e2e", "LIMIT = 100", "LIMIT = 101", 1, { testCommandId: "e2e" }),
        ],
      }),
    );
    expect(execution.positiveControls.map((c) => [c.id, c.outcome])).toEqual([
      ["control-unit", "killed"],
      ["control-e2e", "survived"],
    ]);
    expect(outcomes(execution)).toEqual({ "via-unit": "killed", "via-e2e": "error" });
  });

  it("refuses a control with no command or an unknown one", async () => {
    const { execution } = await execute(
      plan({ positiveControls: [control(null), control("nope")], mutants: [] }),
    );
    expect(execution.positiveControls.map((c) => [c.outcome, c.evidence])).toEqual([
      ["error", expect.stringContaining("names no test command")],
      ["error", expect.stringContaining("names no test command")],
    ]);
    expect(summarize(execution).verdict).toBe("inconclusive");
  });

  it("runs no mutants against a baseline that fails", async () => {
    baselineFails = true;
    const { execution } = await execute(
      plan({ mutants: [mutant("m", "LIMIT = 100", "LIMIT = 101", 1)] }),
    );
    expect(execution.baselines[0]).toMatchObject({
      passed: false,
      problem: "1 tests failed before any mutation",
    });
    expect(execution.mutants[0]).toMatchObject({ outcome: "error" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a test command outside the allowlist without running it", async () => {
    const { execution } = await execute(
      plan({ testCommands: [{ id: "unit", argv: ["sh", "-c", "curl evil"], testFiles: [] }] }),
    );
    expect(execution.baselines[0]?.problem).toContain("not an allowed test runner");
    expect(calls).toHaveLength(0);
  });

  it("drops equivalents before applying the cap", async () => {
    const { execution } = await execute(
      plan({
        mutants: [
          mutant("eq", "LIMIT = 100", "LIMIT = 100.0", 1, { likelyEquivalent: true }),
          mutant("a", "LIMIT = 100", "LIMIT = 101", 1),
          mutant("b", "RATE = 0.8", "RATE = 0.9", 2),
          mutant("c", "RATE = 0.8", "RATE = 0.7", 2),
        ],
      }),
      undefined,
      2,
    );
    expect(execution.mutants.map((m) => m.id)).toEqual(["a", "b", "eq"]);
    expect(execution.planned).toBe(3);
  });

  it("fails closed when the tests swap the file for a symlink", async () => {
    const elsewhere = join(root, "elsewhere.ts");
    writeFileSync(elsewhere, "outside\n");
    onRun = () => {
      if (readFileSync(file(), "utf8").includes("LIMIT = 101")) {
        rmSync(file());
        symlinkSync(elsewhere, file());
      }
    };
    await expect(
      execute(plan({ mutants: [mutant("m", "LIMIT = 100", "LIMIT = 101", 1)] })),
    ).rejects.toBeInstanceOf(RevertError);
    expect(readFileSync(elsewhere, "utf8")).toBe("outside\n");
  });
});

describe("cancelling", () => {
  async function cancelWhen(blocking: string) {
    blockOn = blocking;
    const controller = new AbortController();
    const running = execute(plan(), controller.signal);
    for (let i = 0; i < 400 && !readFileSync(file(), "utf8").includes(blocking); i++) {
      if (blocking === SOURCE && calls.length > 0) break;
      await Bun.sleep(5);
    }
    controller.abort();
    const result = await running;
    expect(readFileSync(file(), "utf8")).toBe(SOURCE);
    return result;
  }

  it("keeps the results so far when cancelled mid-mutant", async () => {
    const { execution, updates } = await cancelWhen("RATE = 0.9");
    expect(execution.mutants.map((m) => m.id)).toEqual(["killed"]);
    expect(updates.at(-1)?.mutants.map((m) => m.id)).toEqual(["killed"]);
    expect(summarize(execution).notes.join(" ")).toContain("Stopped after 1 of 9");
  });

  it("stops during the control", async () => {
    const { execution } = await cancelWhen("return 999");
    expect(execution.positiveControls).toEqual([]);
    expect(execution.mutants).toEqual([]);
  });

  it("stops during the baseline", async () => {
    blockOn = "export const LIMIT = 100;";
    const controller = new AbortController();
    const running = execute(plan(), controller.signal);
    for (let i = 0; i < 400 && calls.length === 0; i++) await Bun.sleep(5);
    controller.abort();
    const { execution } = await running;
    expect(execution.baselines).toEqual([]);
    expect(execution.mutants).toEqual([]);
  });
});

describe("scoring a run", () => {
  const argv = ["bun", "test"];
  it("needs a failing test for a kill and a clean pass for a survivor", () => {
    expect(classify(done(1, FAIL), argv, 3).outcome).toBe("killed");
    expect(classify(done(0, PASS), argv, 3).outcome).toBe("survived");
    // Exit 0 but a test reported failing: proves nothing.
    expect(classify(done(0, FAIL), argv, 3).outcome).toBe("error");
    // Exit non-zero with nothing failing: a crash, not a catch.
    const crash = classify(done(1, PASS), argv, 3);
    expect(crash.outcome).toBe("error");
    expect(crash.evidence).toContain("exited with code 1");
    expect(classify(done(1, "boom"), argv, 3).evidence).toContain("didn't say how many tests ran");
    expect(classify(done(null, "", { timedOut: true }), argv, 3).outcome).toBe("timeout");
  });
});
