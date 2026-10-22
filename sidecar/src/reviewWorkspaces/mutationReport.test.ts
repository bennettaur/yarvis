import { describe, expect, it } from "bun:test";
import {
  type BaselineResult,
  type MutantOutcome,
  type MutantResult,
  type MutationExecution,
  summarize,
} from "./mutationReport.ts";

function mutant(outcome: MutantOutcome, id: string = outcome): MutantResult {
  return {
    id,
    path: "src/a.ts",
    line: 1,
    oldText: "a",
    newText: "b",
    description: "",
    rationale: "",
    testCommandId: "unit",
    testFiles: [],
    outcome,
    durationMs: 1,
    testCount: 3,
    evidence: "",
  };
}

function execution(
  outcomes: MutantOutcome[],
  control: MutantOutcome | null = "killed",
): MutationExecution {
  return {
    baselines: [
      {
        id: "unit",
        argv: ["bun", "test"],
        testFiles: [],
        passed: true,
        exitCode: 0,
        durationMs: 10,
        testCount: 3,
        problem: null,
        excerpt: "",
      },
    ],
    positiveControl: control ? mutant(control, "positive-control") : null,
    mutants: outcomes.map((o, i) => mutant(o, `m${i}`)),
    planned: outcomes.length,
  };
}

const many = (n: number, outcome: MutantOutcome) => Array<MutantOutcome>(n).fill(outcome);

describe("the verdict", () => {
  it("is strong at a 90% kill rate over at least five mutants", () => {
    const summary = summarize(execution([...many(9, "killed"), "survived"]));
    expect(summary).toMatchObject({
      killed: 9,
      survived: 1,
      valid: 10,
      killRate: 0.9,
      verdict: "strong",
    });
  });

  it("is only mixed at a perfect rate over fewer than five", () => {
    expect(summarize(execution(many(4, "killed"))).verdict).toBe("mixed");
  });

  it("is weak below 60%", () => {
    const summary = summarize(execution([...many(2, "killed"), ...many(2, "survived")]));
    expect(summary.killRate).toBe(0.5);
    expect(summary.verdict).toBe("weak");
  });

  it("is mixed in between", () => {
    expect(summarize(execution([...many(7, "killed"), ...many(3, "survived")])).verdict).toBe(
      "mixed",
    );
  });

  it("counts timeouts as kills, and says so", () => {
    const summary = summarize(execution([...many(4, "timeout"), ...many(5, "killed")]));
    expect(summary).toMatchObject({ timeouts: 4, killed: 5, killRate: 1, verdict: "strong" });
    expect(summary.notes.join(" ")).toContain("Stryker");
  });

  it("leaves errors, uncovered and equivalent mutants out of the score", () => {
    const summary = summarize(
      execution([...many(5, "killed"), "error", "error", "uncovered", "equivalent", "equivalent"]),
    );
    expect(summary).toMatchObject({
      valid: 5,
      errors: 2,
      uncovered: 1,
      equivalent: 2,
      killRate: 1,
      verdict: "strong",
    });
  });

  it("is inconclusive with fewer than three valid mutants", () => {
    const summary = summarize(execution(["killed", "killed", "error", "uncovered"]));
    expect(summary.verdict).toBe("inconclusive");
    expect(summary.notes.join(" ")).toContain("at least 3");
  });

  it("is inconclusive when the positive control survives or never ran", () => {
    for (const control of ["survived", "error", null] as const) {
      const summary = summarize(execution(many(10, "killed"), control));
      expect(summary.verdict).toBe("inconclusive");
      expect(summary.notes.join(" ")).toMatch(/positive control/);
    }
  });

  it("names a baseline that couldn't be used and marks partial results", () => {
    const ex = execution(["killed"]);
    ex.planned = 5;
    ex.baselines.push({
      ...(ex.baselines[0] as BaselineResult),
      id: "e2e",
      argv: ["npm", "test"],
      passed: false,
      problem: "it ran no tests",
    });
    const notes = summarize(ex, { finished: false }).notes.join(" ");
    expect(notes).toContain("`npm test` couldn't be used: it ran no tests");
    expect(notes).toContain("Stopped after 1 of 5 mutants");
  });
});
