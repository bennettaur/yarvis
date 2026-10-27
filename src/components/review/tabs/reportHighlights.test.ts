import { describe, expect, it } from "bun:test";
import type { VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { fileNotes, reportDecorations } from "./reportHighlights";

const pass = { status: "pass" as const, findings: [] };

const report: VerificationReport = {
  summary: "Adds a cache.",
  mustRead: [{ path: "src/cache.ts", reason: "Eviction [logic](https://x.test)" }],
  risk: {
    level: "medium",
    clientImpact: "Stale profiles.",
    mitigations: [],
    concerns: [
      { title: "No invalidation", detail: "Edits stay stale.", path: "src/cache.ts", line: 22 },
      { title: "Whole-PR concern", detail: "No line." },
    ],
  },
  completeness: pass,
  tests: pass,
  complexity: pass,
  performance: {
    status: "issues",
    findings: [
      {
        title: "N+1",
        detail: "One query per user.",
        severity: "high",
        path: "src/cache.ts",
        line: 9,
      },
      { title: "Elsewhere", detail: "Other file.", severity: "low", path: "src/b.ts", line: 3 },
    ],
  },
  comments: pass,
  observability: {
    status: "issues",
    findings: [
      {
        title: "Swallowed error",
        detail: "catch drops it.",
        severity: "medium",
        path: "src/cache.ts",
      },
    ],
  },
};

describe("fileNotes", () => {
  it("gathers what cites a line of the file, from risk and every check, in line order", () => {
    expect(fileNotes(report, "src/cache.ts")).toEqual([
      {
        source: "Performance",
        title: "N+1",
        detail: "One query per user.",
        severity: "high",
        line: 9,
      },
      { source: "Risk", title: "No invalidation", detail: "Edits stay stale.", line: 22 },
    ]);
    expect(fileNotes(null, "src/cache.ts")).toEqual([]);
  });
});

describe("reportDecorations", () => {
  it("highlights the must-read range and each cited line, with the reason as plain text", () => {
    const decorations = reportDecorations(
      {
        path: "src/cache.ts",
        reason: "Eviction [logic](https://x.test)",
        lines: { start: 10, end: 40 },
      },
      fileNotes(report, "src/cache.ts"),
    );
    expect(decorations.map((d) => [d.startLine, d.endLine, d.className])).toEqual([
      [10, 40, "review-must-read-line"],
      [9, 9, "review-finding-line"],
      [22, 22, "review-finding-line"],
    ]);
    // A model-written link is escaped, so the hover can't render it.
    expect(decorations[0].hoverMessage).toBe(
      "Must read: Eviction \\[logic\\]\\(https://x\\.test\\)",
    );
    expect(decorations[1].hoverMessage).toBe(
      "Performance \\(high\\): N\\+1\\. One query per user\\.",
    );
  });

  it("has no range for a must-read without lines", () => {
    expect(reportDecorations(report.mustRead[0], [])).toEqual([]);
  });
});
