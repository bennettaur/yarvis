import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type {
  MutantResult,
  MutationFinding,
  MutationSummary,
} from "../../../lib/reviewWorkspaces/mutation";
import { renderToHtml, textOf } from "../../../test/render";
import MutationReportView from "./MutationReportView";

const mutant = (id: string, over: Partial<MutantResult> = {}): MutantResult => ({
  id,
  path: "src/limits.ts",
  line: 12,
  oldText: "count < max",
  newText: "count <= max",
  description: "boundary moved",
  rationale: "",
  testCommandId: "unit",
  testFiles: ["src/limits.test.ts"],
  outcome: "killed",
  durationMs: 10,
  testCount: 4,
  evidence: "",
  ...over,
});

const summary: MutationSummary = {
  killed: 4,
  survived: 1,
  timeouts: 0,
  errors: 1,
  uncovered: 1,
  equivalent: 0,
  valid: 5,
  killRate: 0.8,
  verdict: "mixed",
  notes: ["Timeouts count as kills, as Stryker scores them."],
};

const mutants = [
  mutant("k1"),
  mutant("k2"),
  mutant("k3"),
  mutant("k4"),
  mutant("s1", {
    outcome: "survived",
    path: "src/elsewhere.ts",
    evidence: "**4 pass** <img src=x onerror=alert(1)>",
  }),
  mutant("u1", { outcome: "uncovered", description: "dropped a guard" }),
  mutant("e1", { outcome: "error", description: "didn't compile", evidence: "tsc: error" }),
];

const findings: MutationFinding[] = [
  {
    mutantId: "s1",
    path: "src/elsewhere.ts",
    line: 12,
    title: "The limit's edge isn't tested",
    detail: "No test sends exactly max items.",
    severity: "high",
    suggestion: "expect(accepts(max)).toBe(false)",
  },
];

const render = (canOpen: (path: string) => boolean) =>
  renderToHtml(
    createElement(MutationReportView, {
      summary,
      mutants,
      findings,
      onOpen: { open: () => {}, canOpen },
    }),
  );

describe("MutationReportView", () => {
  it("gives the verdict first, then each survivor as a finding", async () => {
    const text = textOf(await render(() => true));
    expect(text.indexOf("Mixed")).toBeLessThan(text.indexOf("Survived"));
    expect(text).toContain("The tests caught 4 of 5 mutants (80%).");
    expect(text).toContain("Timeouts count as kills");
    expect(text).toContain("The limit's edge isn't tested");
    expect(text).toContain("- count < max");
    expect(text).toContain("+ count <= max");
    expect(text).toContain("src/limits.test.ts");
    expect(text).toContain("expect(accepts(max)).toBe(false)");
  });

  it("shows untrusted output as plain text, never markup", async () => {
    const html = await render(() => true);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>");
    expect(textOf(html)).toContain("**4 pass** <img src=x onerror=alert(1)>");
  });

  it("folds the other outcomes away with their counts", async () => {
    const host = document.createElement("div");
    host.innerHTML = await render(() => true);
    const summaries = [...host.querySelectorAll("details > summary")].map((s) => s.textContent);
    expect(summaries).toContain("Caught 4");
    expect(summaries).toContain("No test reaches 1");
    expect(summaries).toContain("Proved nothing 1");
    expect([...host.querySelectorAll("details")].every((d) => !d.open)).toBe(true);
  });

  it("links only paths the PR changes", async () => {
    const host = document.createElement("div");
    host.innerHTML = await render((path) => path === "src/limits.ts");
    const links = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(links).toContain("src/limits.ts:12");
    expect(links).not.toContain("src/elsewhere.ts:12");
    expect(host.textContent).toContain("src/elsewhere.ts:12");
  });
});
