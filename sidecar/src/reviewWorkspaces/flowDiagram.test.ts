import { describe, expect, it } from "bun:test";
import { flowDiagramPrompt, flowDiagramSchema, MAX_MERMAID_CHARS } from "./flowDiagram.ts";

describe("the flow diagram's shape", () => {
  it("drops a diagram too long to render rather than cutting it", () => {
    const parsed = flowDiagramSchema.parse({
      title: "t",
      explanation: "e",
      mermaid: "x".repeat(MAX_MERMAID_CHARS + 1),
    });
    expect(parsed).toMatchObject({ mermaid: "", tooLarge: true });
  });

  it("keeps a diagram right at the limit, trimmed", () => {
    // With its trailing newline the answer is exactly MAX_MERMAID_CHARS long.
    const mermaid = `flowchart TD\n${"x".repeat(MAX_MERMAID_CHARS - 14)}`;
    const parsed = flowDiagramSchema.parse({
      title: "t",
      explanation: "e",
      mermaid: `${mermaid}\n`,
    });
    expect(parsed).toEqual({ title: "t", explanation: "e", mermaid });
  });
});

describe("the run's prompt", () => {
  it("gives only the context's location and the read budget", () => {
    const prompt = flowDiagramPrompt("/tmp/ctx");
    expect(prompt).toContain("REVIEW_CONTEXT=/tmp/ctx\n");
    expect(prompt).toMatch(/READ_BUDGET_KB=\d+$/);
  });
});
