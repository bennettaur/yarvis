import { describe, expect, it } from "bun:test";
import { assembleReport, mergeCoverage, type SectionAnswer } from "./checklist.ts";
import type { Coverage } from "./coverage.ts";
import { runSections } from "./verification.ts";

const coverage = (overrides: Partial<Coverage> = {}): Coverage => ({
  examined: 0,
  total: 3,
  skimmed: [],
  notExamined: [],
  laneGaps: [],
  ...overrides,
});

describe("merging what several runs read", () => {
  it("counts a file examined when any run examined it", () => {
    const merged = mergeCoverage([
      coverage({
        notExamined: [
          { path: "a.ts", reason: "not opened" },
          { path: "b.ts", reason: "not opened" },
        ],
        skimmed: [{ path: "bun.lock", kind: "lockfile" }],
      }),
      coverage({
        notExamined: [
          { path: "b.ts", reason: "read in part" },
          { path: "bun.lock", reason: "not opened" },
        ],
        laneGaps: [{ check: "Test quality", paths: ["b.ts"] }],
      }),
    ]);
    expect(merged).toEqual({
      examined: 1,
      total: 3,
      skimmed: [{ path: "bun.lock", kind: "lockfile" }],
      notExamined: [{ path: "b.ts", reason: "not opened" }],
      laneGaps: [{ check: "Test quality", paths: ["b.ts"] }],
    });
  });

  it("leaves out a run whose count is unknown, and is unknown only when every run's is", () => {
    const one = coverage({ notExamined: [{ path: "a.ts", reason: "not opened" }] });
    expect(mergeCoverage([{ unknown: true }, one])).toEqual({ ...one, examined: 2 });
    expect(mergeCoverage([{ unknown: true }])).toEqual({ unknown: true });
    expect(mergeCoverage([undefined])).toBeUndefined();
  });
});

describe("putting a report together from each section's answer", () => {
  const finding = { title: "b is never read", detail: "d", severity: "medium" as const };
  const at = { path: "src/a.ts", line: 2 };
  const answer = (
    section: SectionAnswer["section"],
    headSha: string,
    stored: SectionAnswer["stored"],
    minutesAgo = 0,
  ): SectionAnswer => ({
    section,
    headSha,
    runId: `${section}@${headSha}`,
    startedAt: new Date(Date.now() - minutesAgo * 60_000),
    stored,
  });

  it("shows a problem once when both answers are from the same commit", () => {
    const report = assembleReport(
      [
        answer("tests", "h1", {
          tests: { status: "issues", findings: [{ ...finding, ...at }] },
          coverage: coverage(),
        }),
        answer("completeness", "h1", {
          completeness: { status: "issues", findings: [{ ...finding, ...at }] },
          coverage: coverage(),
        }),
      ],
      "h1",
    );
    expect(report?.tests?.findings).toHaveLength(1);
    expect(report?.completeness).toEqual({ status: "pass", findings: [] });
  });

  it("keeps both when the answers are from different commits, whose lines may differ", () => {
    const report = assembleReport(
      [
        answer("tests", "h2", {
          tests: { status: "issues", findings: [{ ...finding, ...at }] },
          coverage: coverage(),
        }),
        answer("completeness", "h1", {
          completeness: { status: "issues", findings: [{ ...finding, ...at }] },
          coverage: coverage(),
        }),
      ],
      "h2",
    );
    expect(report?.tests?.findings).toHaveLength(1);
    expect(report?.completeness?.findings).toHaveLength(1);
  });

  it("counts coverage at the PR's head, or at the newest answer's commit when none is", () => {
    const old = coverage({ notExamined: [{ path: "a.ts", reason: "not opened" }] });
    const fresh = coverage();
    const answers = [
      answer("summary", "h1", { summary: "s", mustRead: [], coverage: old }, 30),
      answer("tests", "h2", { tests: { status: "pass", findings: [] }, coverage: fresh }, 5),
    ];
    expect(assembleReport(answers, "h1")?.coverage).toMatchObject({ examined: 2 });
    expect(assembleReport(answers, "h2")?.coverage).toMatchObject({ examined: 3 });
    expect(assembleReport(answers, "h3")?.coverage).toMatchObject({ examined: 3 });
  });

  it("has nothing to show before any section has an answer", () => {
    expect(assembleReport([], "h1")).toBeNull();
  });
});

describe("which sections a run wrote", () => {
  it("reads them from the run's meta, adding the summary every older run wrote", () => {
    expect(runSections({ sections: ["tests"], format: 2 })).toEqual(["tests"]);
    expect(runSections({ sections: ["flow", "tests"] })).toEqual(["summary", "tests", "flow"]);
    // Before sections could be picked, a run wrote the summary, risk and the checks.
    expect(runSections({})).toContain("risk");
    expect(runSections({})).not.toContain("approach");
  });
});
