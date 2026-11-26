import { describe, expect, it } from "bun:test";
import type { ChecklistItem, ChecklistReport } from "../reviewWorkspaces/checklist.ts";
import { estimateReviewMinutes, formatMinutes, prepBody, summarizePrep } from "./summary.ts";

const finding = (severity: "high" | "medium" | "low") => ({
  title: "t",
  detail: "d",
  severity,
});

const current = { result: { current: true } } as unknown as Pick<ChecklistItem, "result">;
const items = (sections: string[], result = current) =>
  sections.map((section) => ({ section, ...result })) as unknown as ChecklistItem[];
const allCurrent = items([
  "summary",
  "changeMap",
  "claims",
  "risk",
  "malice",
  "tests",
  "performance",
  "complexity",
  "comments",
  "observability",
  "quality",
  "approach",
]);

describe("summarizePrep", () => {
  it("finds no problems when every check ran and found nothing", () => {
    const report = { summary: "s", mustRead: [] } as unknown as ChecklistReport;
    expect(summarizePrep(report, allCurrent, null)).toEqual({
      verdict: "no-problems",
      reasons: [],
      mustRead: [],
      reviewMinutes: null,
    });
  });

  it("needs changes for a high finding or an unmet claim, and lists concerns after", () => {
    const report = {
      tests: { status: "issues", findings: [finding("high"), finding("medium")] },
      claims: { items: [{ status: "missing" }, { status: "partial" }], gaps: [] },
      risk: { level: "high" },
    } as unknown as ChecklistReport;
    expect(summarizePrep(report, allCurrent, null)).toMatchObject({
      verdict: "changes-needed",
      reasons: [
        "1 high finding",
        "1 claim not met",
        "high risk",
        "1 claim partly met",
        "1 medium finding",
      ],
    });
  });

  it("wants a closer look at an outlier, a simpler approach or a check with no result", () => {
    const report = {
      changeMap: { themes: [{ cohesion: "outlier" }, { cohesion: "core" }] },
      approach: { rating: "much-simpler" },
    } as unknown as ChecklistReport;
    const missing = [
      ...allCurrent.slice(1),
      ...items(["summary"], { result: null } as unknown as Pick<ChecklistItem, "result">),
    ];
    expect(summarizePrep(report, missing, null)).toMatchObject({
      verdict: "review-deeper",
      reasons: ["1 outlier", "a simpler approach", "1 check without a result"],
    });
  });
});

describe("review time", () => {
  it("rounds up to five minutes, with five at least", () => {
    expect(estimateReviewMinutes({ files: 1, changedLines: 3 })).toBe(5);
    expect(estimateReviewMinutes({ files: 10, changedLines: 300 })).toBe(70);
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(120)).toBe("2 h");
    expect(formatMinutes(95)).toBe("1 h 35 min");
  });
});

describe("prepBody", () => {
  it("lists at most five must-reads and counts the rest", () => {
    const body = prepBody("r#1", "Add retries", {
      verdict: "no-problems",
      reasons: [],
      mustRead: ["a", "b", "c", "d", "e", "f", "g"],
      reviewMinutes: 25,
    });
    expect(body).toBe(
      [
        "r#1: Add retries",
        "Verdict: The checks found no problems.",
        "Must read: a, b, c, d, e, and 2 more.",
        "Estimated review time: about 25 min.",
      ].join("\n"),
    );
  });
});
