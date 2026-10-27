import { describe, expect, it } from "bun:test";
import type { AgentRunEvent } from "../../../lib/agentRuns";
import { initialProgress, reduceProgress } from "./verificationProgress";

const run = (events: AgentRunEvent[]) => events.reduce(reduceProgress, initialProgress());
const stateOf = (progress: ReturnType<typeof run>, agent: string) =>
  progress.checks.find((c) => c.agent === agent);

describe("reduceProgress", () => {
  it("starts with every check waiting", () => {
    expect(initialProgress().checks.every((c) => c.state === "waiting")).toBe(true);
    expect(initialProgress().checks).toHaveLength(7);
  });

  it("follows each check from its subagent's start and stop", () => {
    const progress = run([
      {
        type: "subagent",
        phase: "start",
        id: "s1",
        name: "yarvis-review:risk-reviewer",
        description: "",
      },
      {
        type: "subagent",
        phase: "start",
        id: "s2",
        name: "yarvis-review:test-reviewer",
        description: "",
      },
      {
        type: "subagent",
        phase: "stop",
        id: "s1",
        name: "yarvis-review:risk-reviewer",
        description: "",
      },
      {
        type: "subagent",
        phase: "stop",
        id: "s3",
        name: "comment-reviewer",
        description: "",
        failed: true,
      },
    ]);
    expect(stateOf(progress, "risk-reviewer")?.state).toBe("done");
    expect(stateOf(progress, "test-reviewer")?.state).toBe("running");
    expect(stateOf(progress, "comment-reviewer")?.state).toBe("failed");
    expect(stateOf(progress, "change-summary")?.state).toBe("waiting");
  });

  it("shows a check's latest tool call under it, and the coordinator's on its own", () => {
    const progress = run([
      {
        type: "subagent",
        phase: "start",
        id: "s1",
        name: "yarvis-review:test-reviewer",
        description: "",
      },
      { type: "tool", id: "t1", name: "Read", summary: "src/a.ts", subagentId: "s1" },
      { type: "tool", id: "t2", name: "Grep", summary: "useThing", subagentId: "s1" },
      { type: "tool", id: "t3", name: "Skill", summary: "", subagentId: null },
    ]);
    expect(stateOf(progress, "test-reviewer")?.activity).toBe("Grep useThing");
    expect(progress.activity).toBe("Skill");
  });

  it("ignores a subagent that isn't one of the checks", () => {
    const before = initialProgress();
    const after = reduceProgress(before, {
      type: "subagent",
      phase: "start",
      id: "x",
      name: "general-purpose",
      description: "",
    });
    expect(after).toBe(before);
  });

  it("records how the run ended and why it failed", () => {
    const progress = run([
      { type: "error", message: "budget exceeded" },
      { type: "done", status: "failed" },
    ]);
    expect(progress.error).toBe("budget exceeded");
    expect(progress.finished).toBe("failed");
  });
});
