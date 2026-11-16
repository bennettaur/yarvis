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

describe("fileNotes from the claims", () => {
  it("notes a claim the code doesn't meet and unfinished work, but not a verified claim", () => {
    const notes = fileNotes(
      {
        mustRead: [],
        claims: {
          claims: [
            {
              claim: "Caches users",
              source: "description",
              status: "verified",
              evidence: "e",
              path: "a.ts",
              line: 2,
            },
            {
              claim: "Invalidates",
              source: "ABC-1",
              status: "partial",
              evidence: "only on delete",
              path: "a.ts",
              line: 9,
            },
          ],
          gaps: [{ title: "TODO left", detail: "d", severity: "low", path: "a.ts", line: 5 }],
        },
      },
      "a.ts",
    );
    expect(notes).toEqual([
      { source: "Unfinished work", title: "TODO left", detail: "d", severity: "low", line: 5 },
      { source: "Claim partial", title: "Invalidates", detail: "only on delete", line: 9 },
    ]);
  });
});

describe("fileNotes with must-read flags", () => {
  const flagged: VerificationReport = {
    ...report,
    mustRead: [
      {
        path: "src/cache.ts",
        reason: "Eviction",
        flags: [{ note: "TTL is read but never applied", line: 30 }, { note: "No line" }],
      },
      { path: "src/b.ts", reason: "Other", flags: [{ note: "Flagged in b", line: 5 }] },
    ],
  };

  it("adds each flag that cites a line, labelled apart from the must-read reason", () => {
    const notes = fileNotes(flagged, "src/cache.ts");
    expect(notes.find((n) => n.source === "Looks off")).toEqual({
      source: "Looks off",
      title: "TTL is read but never applied",
      line: 30,
    });
    expect(notes.map((n) => n.line)).toEqual([9, 22, 30]);
    const [, , flag] = reportDecorations(null, notes);
    expect(flag?.hoverMessage).toBe("Looks off\\: TTL is read but never applied");
  });

  it("takes flags only from the file's own must-read", () => {
    expect(fileNotes(flagged, "src/b.ts").map((n) => n.title)).toEqual([
      "Elsewhere",
      "Flagged in b",
    ]);
    expect(fileNotes(flagged, "src/none.ts")).toEqual([]);
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
      "Must read\\: Eviction \\[logic\\]\\(https\\://x\\.test\\)",
    );
    expect(decorations[1].hoverMessage).toBe(
      "Performance \\(high\\)\\: N\\+1\\. One query per user\\.",
    );
  });

  it("has no range for a must-read without lines", () => {
    expect(reportDecorations(report.mustRead[0], [])).toEqual([]);
  });
});
