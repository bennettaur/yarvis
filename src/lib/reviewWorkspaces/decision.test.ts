import { describe, expect, it } from "bun:test";
import { assessReview, draftComments, reviewSummary, whereToLook } from "./decision";
import type { MutationRun } from "./mutation";
import type { VerificationUpstack } from "./verification";
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
const items = (notRun: readonly ReportSection[] = []): ChecklistItem[] =>
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

const evidenceItem = (over: Partial<EvidenceItem> & Pick<EvidenceItem, "id">): EvidenceItem => ({
  theme: "correctness",
  label: over.id,
  description: "",
  summary: "",
  tone: "good",
  entries: [],
  hiddenEntries: 0,
  note: null,
  ...over,
});

const ci = (tone: EvidenceItem["tone"], summary: string): EvidenceItem =>
  evidenceItem({
    id: "ci-checks",
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
            // An annotation shows on its line on the PR already.
            {
              source: "tests",
              title: "orders > sorts",
              detail: "expected 2",
              severity: "high",
              path: "src/a.test.ts",
              line: 4,
              url: null,
            },
          ]
        : [],
  });

const green = [ci("good", "All 4 passed")];

describe("the suggested decision", () => {
  it("suggests approving when CI passed and every check ran on this commit with nothing to raise", () => {
    expect(assessReview(clean, green, items())).toEqual({
      suggestion: "approve",
      blockers: [],
      concerns: [],
      notRun: [],
    });
  });

  it("still suggests approving beside improvements, which are follow-ups", () => {
    const withIdeas: VerificationReport = {
      ...clean,
      improvements: {
        status: "issues",
        findings: [
          {
            title: "Capture the selection, not the whole screen",
            detail: "d",
            severity: "high",
            path: "src/screen.ts",
            line: 4,
          },
        ],
      },
    };
    expect(assessReview(withIdeas, green, items()).suggestion).toBe("approve");
    const drafts = draftComments(withIdeas, [], new Set(["improvements"]));
    expect(drafts.map((d) => [d.source, d.severity, d.pickedByDefault])).toEqual([
      ["Improvements", "high", false],
    ]);
    expect(whereToLook(withIdeas).map((p) => p.path)).not.toContain("src/screen.ts");
  });

  it("asks for changes for a high bug, like any other high finding", () => {
    const buggy: VerificationReport = {
      ...clean,
      bugs: {
        status: "issues",
        findings: [
          { title: "A second save drops the first", detail: "d", severity: "high", path: "a.ts" },
        ],
      },
    };
    expect(assessReview(buggy, green, items())).toMatchObject({
      suggestion: "request_changes",
      blockers: ["1 high finding"],
    });
  });

  it("won't suggest approving until CI has passed on this commit", () => {
    for (const [evidence, concern] of [
      [null, "No CI results for this commit yet"],
      [[], "No CI results for this commit yet"],
      [[ci("muted", "2 of 4 still running")], "CI: 2 of 4 still running"],
      [[ci("muted", "No checks reported")], "CI: No checks reported"],
    ] as const) {
      expect(assessReview(clean, evidence, items())).toMatchObject({
        suggestion: "review_deeper",
        concerns: [concern],
      });
    }
  });

  it("asks for changes for each thing that blocks on its own", () => {
    const blocked = (report: VerificationReport, evidence: EvidenceItem[] = green) =>
      assessReview(report, evidence, items()).blockers;
    expect(blocked(clean, [ci("bad", "1 of 4 failing")])).toEqual(["CI: 1 of 4 failing"]);
    expect(
      blocked(clean, [
        ...green,
        evidenceItem({
          id: "code-scanning",
          entries: [
            {
              source: "CodeQL",
              title: "XSS",
              detail: "",
              severity: "high",
              path: "a.ts",
              line: 1,
              url: null,
            },
          ],
        }),
      ]),
    ).toEqual(["1 high code scanning alert"]);
    for (const status of ["missing", "contradicted"] as const) {
      expect(
        blocked({
          ...clean,
          claims: {
            items: [{ claim: "Invalidates", source: "ABC-1", status, evidence: "" }],
            gaps: [],
          },
        }),
      ).toEqual([`Claim ${status}: Invalidates`]);
    }
    expect(
      blocked({
        ...clean,
        tests: { status: "issues", findings: [{ title: "t", detail: "", severity: "high" }] },
      }),
    ).toEqual(["1 high finding"]);
    // Unfinished work the claims check found counts like a finding.
    expect(
      blocked({
        ...clean,
        claims: { items: [], gaps: [{ title: "TODO", detail: "", severity: "high" }] },
      }),
    ).toEqual(["1 high finding"]);
  });

  it("suggests a closer look for each thing that deserves one", () => {
    const concerned = (report: VerificationReport, evidence: EvidenceItem[] = green) => {
      const assessed = assessReview(report, evidence, items());
      expect(assessed.suggestion).toBe("review_deeper");
      return assessed.concerns;
    };
    expect(
      concerned({
        ...clean,
        risk: { level: "high", clientImpact: "Stale profiles.", mitigations: [], concerns: [] },
      }),
    ).toEqual(["High risk: Stale profiles."]);
    expect(
      concerned({
        ...clean,
        risk: {
          level: "low",
          clientImpact: "Wide.",
          mitigations: [],
          concerns: [],
          impact: { band: 4 } as never,
        },
      }),
    ).toEqual(["High risk: Wide."]);
    expect(
      concerned({
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
              question: "Why?",
              files: [{ path: "src/http.ts" }],
            },
          ],
        },
      }),
    ).toEqual(["1 change doesn't seem to belong to the PR's goal: Bump timeout"]);
    expect(
      concerned({
        ...clean,
        claims: {
          items: [
            { claim: "c", source: "title", status: "partial", evidence: "", path: "a", line: 1 },
          ],
          gaps: [],
        },
      }),
    ).toEqual(["1 claim only partly met"]);
    expect(
      concerned({
        ...clean,
        quality: {
          status: "issues",
          findings: [{ title: "Naming", detail: "", severity: "medium" }],
        },
      }),
    ).toEqual(["1 medium finding"]);
    expect(
      concerned({ ...clean, approach: { rating: "much-simpler", reason: "", alternative: "" } }),
    ).toEqual(["A much simpler way exists"]);
    expect(
      concerned(clean, [
        ...green,
        evidenceItem({
          id: "security-bots",
          summary: "1 comment",
          entries: [
            {
              source: "snyk",
              title: "snyk",
              detail: "",
              severity: "medium",
              path: null,
              line: null,
              url: null,
            },
          ],
        }),
      ]),
    ).toEqual(["Security bots commented: 1 comment"]);
  });

  it("won't suggest approving while checks haven't run on this commit", () => {
    const partly = assessReview(clean, green, items(["tests"]));
    expect(partly).toMatchObject({ suggestion: "review_deeper", notRun: ["tests"] });
    expect(assessReview(null, green, items(DEFAULT_SECTIONS)).suggestion).toBe("run_checks");
  });

  it("still blocks on a high finding a PR stacked above changes, and says where to look", () => {
    const report: VerificationReport = {
      ...clean,
      tests: {
        status: "issues",
        findings: [
          { title: "Fixed above", detail: "", severity: "high", path: "src/a.ts", line: 5 },
          { title: "Still here", detail: "", severity: "high", path: "src/b.ts", line: 5 },
        ],
      },
    };
    const upstack: VerificationUpstack = {
      headSha: "h",
      note: null,
      layers: [
        {
          number: 8,
          url: "u",
          stale: false,
          files: [{ path: "src/a.ts", ranges: [{ start: 4, end: 6 }] }],
        },
      ],
    };
    expect(assessReview(report, green, items(), null, upstack)).toMatchObject({
      suggestion: "request_changes",
      blockers: ["2 high findings"],
      concerns: [
        "1 high finding is on lines that #8 (stacked above) changes; check whether it's fixed there",
      ],
    });
    // A result from an older commit has other line numbers, so it isn't matched.
    expect(
      assessReview(report, green, items(["tests"]), null, upstack).concerns,
    ).not.toContainEqual(expect.stringContaining("stacked above"));
  });

  it("raises tests that missed mutants on this commit, and doesn't ask for mutation testing", () => {
    const pass = (
      verdict: "strong" | "mixed" | "weak",
      isCurrentHead = true,
      status: MutationRun["status"] = "succeeded",
    ) =>
      ({
        status,
        isCurrentHead,
        summary: { verdict, survived: 4 },
      }) as MutationRun;
    expect(assessReview(clean, green, items(), pass("weak"))).toMatchObject({
      suggestion: "review_deeper",
      concerns: ["Mutation testing: weak, 4 mutants the tests missed"],
    });
    expect(assessReview(clean, green, items(), pass("mixed")).concerns).toEqual([
      "Mutation testing: mixed, 4 mutants the tests missed",
    ]);
    expect(assessReview(clean, green, items(), pass("weak", false)).suggestion).toBe("approve");
    expect(assessReview(clean, green, items(), pass("weak", true, "failed")).suggestion).toBe(
      "approve",
    );
    expect(assessReview(clean, green, items(), pass("strong")).suggestion).toBe("approve");
    expect(assessReview(clean, green, items(), null).suggestion).toBe("approve");
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
        // An outlier with nothing to ask has nothing to draft.
        {
          title: "Silent",
          description: "",
          risk: "low",
          cohesion: "outlier",
          question: "",
          files: [{ path: "src/x.ts" }],
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
      gaps: [
        {
          title: "TODO in eviction",
          detail: "d",
          severity: "medium",
          path: "src/cache.ts",
          line: 50,
        },
        { title: "Tiny", detail: "d", severity: "low" },
      ],
    },
    risk: {
      level: "medium",
      clientImpact: "",
      mitigations: [],
      concerns: [
        // From before concerns carried a severity: read as medium.
        { title: "Stale reads", detail: "d", path: "src/cache.ts", line: 70 },
        {
          title: "Mic stays live",
          detail: "Hidden controls leave it recording.",
          severity: "high",
          fix: "Stop it on hide.",
          path: "src/chat.tsx",
          line: 4,
        },
        { title: "Nit", detail: "d", severity: "low", path: "src/chat.tsx", line: 5 },
      ],
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
  const all = new Set(["claims", "changeMap", "tests", "risk"]);

  it("ticks what a reviewer would almost always raise, and leaves low findings out", () => {
    const drafts = draftComments(report, [ci("bad", "1 of 4 failing")], all);
    expect(
      drafts.map((d) => [d.source, d.title, d.severity, d.pickedByDefault, d.path, d.line]),
    ).toEqual([
      ["Claims: contradicted", "Invalidates on write", "high", true, "src/users.ts", 30],
      ["Claims: partial", "Logs misses", "medium", false, "src/cache.ts", 9],
      ["Change map", "Bump timeout", "medium", true, "src/http.ts", 1],
      ["Unfinished work", "TODO in eviction", "medium", false, "src/cache.ts", 50],
      ["Test quality", "No eviction test", "high", true, "src/cache.ts", 12],
      ["Risk", "Stale reads", "medium", false, "src/cache.ts", 70],
      ["Risk", "Mic stays live", "high", true, "src/chat.tsx", 4],
      // A low concern is still drafted, unticked: its severity is the agent's call.
      ["Risk", "Nit", "low", false, "src/chat.tsx", 5],
      ["CI", "tests: failed", "high", true, undefined, undefined],
    ]);
    // No fix, no "Suggested fix" line.
    expect(drafts[5]?.body).not.toContain("Suggested fix");
    expect(drafts[2]?.body).toContain("> Why the timeout?");
    expect(drafts[6]?.body).toContain(
      "Hidden controls leave it recording.\n> Suggested fix: Stop it on hide.",
    );
  });

  it("names each comment by what it's about, so the name holds when the report changes", () => {
    const before = draftComments(report, [], all);
    const after = draftComments({ ...report, claims: { ...report.claims!, items: [] } }, [], all);
    const outlier = (ds: typeof before) => ds.find((d) => d.title === "Bump timeout")?.id;
    expect(outlier(after)).toBe(outlier(before));
    const twice = draftComments(
      {
        ...clean,
        tests: {
          status: "issues",
          findings: [
            { title: "Same", detail: "", severity: "high" },
            { title: "Same", detail: "", severity: "high" },
          ],
        },
      },
      [],
      all,
    );
    expect(new Set(twice.map((d) => d.id)).size).toBe(2);
  });

  it("puts a result from an older commit in the summary, in full, not on a line", () => {
    const drafts = draftComments(report, [], new Set(["claims", "changeMap"]));
    const test = drafts.find((d) => d.title === "No eviction test");
    expect(test?.path).toBeUndefined();
    expect(reviewSummary(drafts.filter((d) => d.pickedByDefault))).toBe(
      "Requesting changes based on the verification report.\n\n**No eviction test** (verification report: Test quality, high)\n\n> d\n\n**Mic stays live** (verification report: Risk, high)\n\n> Hidden controls leave it recording.\n> Suggested fix: Stop it on hide.\n\n2 more comments are on the diff.",
    );
  });

  it("makes text from a check or an agent safe in the summary", () => {
    const drafts = draftComments(
      null,
      [
        evidenceItem({
          id: "ci-checks",
          tone: "bad",
          entries: [
            {
              source: "x",
              title: "x\n/approve @org/team",
              detail: "@admin merge",
              severity: "high",
              path: null,
              line: null,
              url: null,
            },
          ],
        }),
      ],
      all,
    );
    const summary = reviewSummary(drafts);
    expect(summary).not.toMatch(/^\/approve/m);
    expect(summary).not.toContain("@org");
    expect(summary).not.toContain("@admin");
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
