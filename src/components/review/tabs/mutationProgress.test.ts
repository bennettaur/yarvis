import { describe, expect, it } from "bun:test";
import type { MutantResult, MutationProgressEvent } from "../../../lib/reviewWorkspaces/mutation";
import { initialMutationProgress, reduceMutationProgress } from "./mutationProgress";

const mutant = (id: string, over: Partial<MutantResult> = {}): MutantResult => ({
  id,
  path: "src/a.ts",
  line: 3,
  oldText: "a < b",
  newText: "a <= b",
  description: "off by one",
  rationale: "",
  testCommandId: "t1",
  testFiles: ["src/a.test.ts"],
  outcome: "killed",
  durationMs: 10,
  testCount: 4,
  evidence: "",
  ...over,
});

const fold = (events: MutationProgressEvent[]) =>
  events.reduce(reduceMutationProgress, initialMutationProgress());

describe("reduceMutationProgress", () => {
  it("follows the phases and clears the agent's activity between them", () => {
    const state = fold([
      { type: "phase", phase: "planning" },
      {
        type: "agent",
        phase: "planning",
        event: { type: "tool", id: "1", name: "Read", summary: "src/a.ts", subagentId: null },
      },
    ]);
    expect(state.phase).toBe("planning");
    expect(state.activity).toBe("Read src/a.ts");
    expect(fold([{ type: "phase", phase: "baseline" }]).activity).toBeNull();
  });

  it("keeps the control apart from the mutants and counts toward the total", () => {
    const state = fold([
      {
        type: "mutant",
        result: mutant("c", { outcome: "killed" }),
        index: 0,
        total: 1,
        control: true,
      },
      { type: "mutant", result: mutant("m1"), index: 0, total: 3, control: false },
      {
        type: "mutant",
        result: mutant("m2", { outcome: "survived" }),
        index: 1,
        total: 3,
        control: false,
      },
    ]);
    expect(state.controls.map((m) => m.id)).toEqual(["c"]);
    expect(state.mutants.map((m) => [m.id, m.outcome])).toEqual([
      ["m1", "killed"],
      ["m2", "survived"],
    ]);
    expect(state.total).toBe(3);
  });

  it("counts a result once when the stream replays it", () => {
    const event: MutationProgressEvent = {
      type: "mutant",
      result: mutant("m1"),
      index: 0,
      total: 2,
      control: false,
    };
    expect(fold([event, event]).mutants).toHaveLength(1);
    const baseline: MutationProgressEvent = {
      type: "baseline",
      result: {
        id: "t1",
        argv: ["bun", "test"],
        testFiles: [],
        passed: true,
        exitCode: 0,
        durationMs: 5,
        testCount: 4,
        problem: null,
        excerpt: "",
      },
    };
    expect(fold([baseline, baseline]).baselines).toHaveLength(1);
  });

  it("ends on done, keeps an error, and ignores pings", () => {
    const state = fold([
      { type: "ping" },
      { type: "error", message: "the planning run hit its budget" },
      { type: "done", status: "failed" },
    ]);
    expect(state.finished).toBe("failed");
    expect(state.phase).toBe("done");
    expect(state.error).toBe("the planning run hit its budget");
  });
});
