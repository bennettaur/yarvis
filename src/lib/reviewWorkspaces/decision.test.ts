import { describe, expect, it } from "bun:test";
import { assessReview, draftComments, reviewSummary, whereToLook } from "./decision";
import {
  type ChecklistItem,
  type ChecklistRun,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  type ReportSection,
  type VerificationReport,
} from "./verification";

const run = (current: boolean): ChecklistRun => ({
  id: "r",
  status: "succeeded",
  live: false,
  headSha: "h",
  current,
  error: null,
  costUsd: null,
  startedAt: "",
  finishedAt: null,
});

/** Every default section, each with a current result unless listed in `notRun`. */
const items = (notRun: ReportSection[] = []): ChecklistItem[] =>
  DEFAULT_SECTIONS.map((section) => ({
    section,
    theme: "correctness",
    label: section,
    description: "",
    latest: run(!notRun.includes(section)),
    result: notRun.includes(section) ? null : run(true),
  }));

const pass = { status: "pass" as const, findings: [] };

const clean: VerificationReport = {
  summary: "Adds a cache.",
  mustRead: [],
  changeMap: {
    intent: "Cache user lookups.",
    unmapped: [],
    themes: [
      {
        title: "Cache lookups",
        description: "",
        risk: "medium",
        cohesion: "core",
        question: "",
        files: [{ path: "src/cache.ts" }],
      },
    ],
  },
  claims: {
    items: [
      {
        claim: "Caches",
        source: "description",
        status: "verified",
        evidence: "",
        path: "src/cache.ts",
        line: 3,
      },
    ],
    gaps: [],
  },
  risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
  tests: pass,
  complexity: pass,
  performance: pass,
  comments: pass,
  observability: pass,
  quality: pass,
  approach: { rating: "no-simpler", reason: "", alternative: "" },
};

const ci = (tone: EvidenceItem["tone"], summary: string): EvidenceItem => ({
  id: "ci-checks",
  theme: "correctness",
  label: "CI checks",
  description: "",
  summary,
  tone,
  entries:
    tone === "bad"
      ? [
          {
            source: "tests",
            title: "tests: failed",
            detail: "2 failed",
            severity: "high",
            path: null,
            line: null,
            url: null,
          },
        ]
      : [],
  hiddenEntries: 0,
  note: null,
});

describe("the suggested decision", () => {
  it("suggests approving when every check ran on this commit and nothing stands out", () => {
    expect(assessReview(clean, [ci("good", "All 4 passed")], items())).toEqual({
      suggestion: "approve",
      blockers: [],
      concerns: [],
      notRun: [],
    });
  });

  it("asks for changes when CI fails, a claim isn't met or a check found something high", () => {
    const report: VerificationReport = {
      ...clean,
      claims: {
        items: [
          { claim: "Invalidates on write", source: "ABC-1", status: "missing", evidence: "" },
        ],
        gaps: [],
      },
      tests: { status: "issues", findings: [{ title: "No test", detail: "", severity: "high" }] },
    };
    const { suggestion, blockers } = assessReview(report, [ci("bad", "1 of 4 failing")], items());
    expect(suggestion).toBe("request_changes");
    expect(blockers).toEqual([
      "CI: 1 of 4 failing",
      "Claim missing: Invalidates on write",
      "1 high finding",
    ]);
  });

  it("suggests a closer look for risk, outliers, partial claims and medium findings", () => {
    const report: VerificationReport = {
      ...clean,
      risk: { level: "high", clientImpact: "Stale profiles.", mitigations: [], concerns: [] },
      changeMap: {
        intent: "i",
        unmapped: [],
        themes: [
          {
            title: "Bump timeout",
            description: "",
            risk: "low",
            cohesion: "outlier",
            question: "Why?",
            files: [{ path: "src/http.ts" }],
          },
        ],
      },
      claims: {
        items: [
          { claim: "c", source: "title", status: "partial", evidence: "", path: "a", line: 1 },
        ],
        gaps: [],
      },
      quality: {
        status: "issues",
        findings: [{ title: "Naming", detail: "", severity: "medium" }],
      },
    };
    const { suggestion, concerns } = assessReview(report, [], items());
    expect(suggestion).toBe("review_deeper");
    expect(concerns).toEqual([
      "1 claim only partly met",
      "1 medium finding",
      "High risk: Stale profiles.",
      "1 change doesn't belong to the PR's goal: Bump timeout",
    ]);
  });

  it("won't suggest approving while checks haven't run on this commit", () => {
    const partly = assessReview(clean, [], items(["tests"]));
    expect(partly).toMatchObject({ suggestion: "review_deeper", notRun: ["tests"] });
    const none = assessReview(null, [], items([...DEFAULT_SECTIONS]));
    expect(none.suggestion).toBe("run_checks");
  });
});

describe("drafting a request for changes", () => {
  const report: VerificationReport = {
    ...clean,
    changeMap: {
      intent: "i",
      unmapped: [],
      themes: [
        {
          title: "Bump timeout",
          description: "",
          risk: "low",
          cohesion: "outlier",
          question: "Why the timeout?",
          files: [{ path: "src/http.ts" }],
        },
      ],
    },
    claims: {
      items: [
        {
          claim: "Invalidates on write",
          source: "ABC-1",
          status: "contradicted",
          evidence: "Only on delete",
          path: "src/users.ts",
          line: 30,
        },
        {
          claim: "Logs misses",
          source: "description",
          status: "partial",
          evidence: "Only some",
          path: "src/cache.ts",
          line: 9,
        },
      ],
      gaps: [],
    },
    tests: {
      status: "issues",
      findings: [
        {
          title: "No eviction test",
          detail: "d",
          severity: "high",
          path: "src/cache.ts",
          line: 12,
        },
        { title: "Minor", detail: "d", severity: "low", path: "src/cache.ts", line: 13 },
      ],
    },
  };

  it("ticks what a reviewer would almost always raise, and leaves low findings out", () => {
    const drafts = draftComments(
      report,
      [ci("bad", "1 of 4 failing")],
      new Set(["claims", "changeMap", "tests"]),
    );
    expect(drafts.map((d) => [d.title, d.severity, d.picked, d.path, d.line])).toEqual([
      ["Invalidates on write", "high", true, "src/users.ts", 30],
      ["Logs misses", "medium", false, "src/cache.ts", 9],
      ["Bump timeout", "medium", true, "src/http.ts", 1],
      ["No eviction test", "high", true, "src/cache.ts", 12],
      ["tests: failed", "high", true, undefined, undefined],
    ]);
    expect(drafts[2]?.body).toContain("> Why the timeout?");
  });

  it("puts a result from an older commit in the summary, not on a line", () => {
    const drafts = draftComments(report, [], new Set(["claims", "changeMap"]));
    const test = drafts.find((d) => d.title === "No eviction test");
    expect(test?.path).toBeUndefined();
    expect(reviewSummary(drafts.filter((d) => d.picked))).toBe(
      "Requesting changes, from the verification report.\n\n- **No eviction test** (Test quality)\n\n2 comments are on the lines they're about.",
    );
  });
});

describe("where to look", () => {
  it("lists outliers, then high-risk themes, must-reads and high findings, each file once", () => {
    const report: VerificationReport = {
      ...clean,
      mustRead: [
        { path: "src/cache.ts", reason: "the eviction logic" },
        { path: "src/users.ts", reason: "write path" },
      ],
      changeMap: {
        intent: "i",
        unmapped: [],
        themes: [
          {
            title: "Cache",
            description: "",
            risk: "high",
            cohesion: "core",
            question: "",
            files: [{ path: "src/cache.ts", lines: { start: 5, end: 9 } }],
          },
          {
            title: "Timeout",
            description: "",
            risk: "low",
            cohesion: "outlier",
            question: "?",
            files: [{ path: "src/http.ts" }],
          },
        ],
      },
      performance: {
        status: "issues",
        findings: [{ title: "N+1", detail: "", severity: "high", path: "src/db.ts", line: 4 }],
      },
    };
    expect(whereToLook(report)).toEqual([
      { path: "src/http.ts", line: undefined, reason: "Outlier: Timeout" },
      { path: "src/cache.ts", line: 5, reason: "High risk: Cache" },
      { path: "src/users.ts", line: undefined, reason: "write path" },
      { path: "src/db.ts", line: 4, reason: "Performance: N+1" },
    ]);
    expect(whereToLook(null)).toEqual([]);
  });
});
