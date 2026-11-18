import { describe, expect, it } from "bun:test";
import { assessReview } from "./decision";
import { type ReportExportInput, verificationReportMarkdown } from "./exportReport";
import type { MutationRun } from "./mutation";
import type { ChecklistItem, ChecklistRun, EvidenceItem, VerificationReport } from "./verification";

const run = (over: Partial<ChecklistRun> = {}): ChecklistRun => ({
  id: "r1",
  status: "succeeded",
  live: false,
  headSha: "abcdef1234",
  current: true,
  error: null,
  costUsd: null,
  startedAt: "",
  finishedAt: null,
  ...over,
});

const item = (
  section: ChecklistItem["section"],
  label: string,
  result: ChecklistRun | null,
  latest: ChecklistRun | null = result,
): ChecklistItem => ({ section, theme: "correctness", label, description: "", latest, result });

const report: VerificationReport = {
  summary: "Adds a retry to uploads.",
  mustRead: [
    {
      path: "src/upload.ts",
      reason: "The retry loop.",
      lines: { start: 10, end: 30 },
      flags: [{ note: "No backoff.", line: 12 }],
    },
  ],
  changeMap: {
    intent: "Retry failed uploads.",
    unmapped: ["README.md"],
    themes: [
      {
        title: "Drive-by rename",
        description: "Renames a helper.",
        risk: "low",
        cohesion: "outlier",
        question: "Why rename this here?",
        files: [{ path: "src/util.ts" }],
      },
    ],
  },
  claims: {
    items: [
      {
        claim: "Retries three times",
        source: "description",
        status: "contradicted",
        evidence: "It retries forever.",
        path: "src/upload.ts",
        line: 14,
      },
    ],
    gaps: [],
  },
  tests: {
    status: "issues",
    findings: [
      {
        title: "No test for give-up",
        detail: "Nothing covers\nthe last attempt.",
        severity: "high",
        path: "src/upload.test.ts",
      },
    ],
  },
  complexity: { status: "pass", findings: [] },
  flow: { title: "Upload", explanation: "Client to store.", mermaid: "flowchart LR\n  a --> b" },
};

const evidence: EvidenceItem[] = [
  {
    id: "ci-checks",
    theme: "correctness",
    label: "CI checks",
    description: "",
    summary: "1 failed",
    tone: "bad",
    entries: [
      {
        source: "ci / test",
        title: "Test failed",
        detail: "",
        severity: "high",
        path: "src/upload.test.ts",
        line: 8,
        url: null,
      },
    ],
    hiddenEntries: 2,
    note: null,
  },
];

const items: ChecklistItem[] = [
  item("summary", "Summary", run()),
  item("tests", "Test quality", run({ current: false, headSha: "0123456789" })),
  item("risk", "Risk", null, run({ id: "r2", status: "failed", error: "timed out" })),
];

function input(over: Partial<ReportExportInput> = {}): ReportExportInput {
  return {
    pr: {
      title: "Retry uploads",
      url: "https://github.com/o/r/pull/7",
      author: "someone",
      headRef: "retry",
      baseRef: "main",
    },
    headSha: "abcdef1234",
    report,
    items,
    assessment: assessReview(report, evidence, items),
    evidence,
    mutation: null,
    ...over,
  };
}

describe("verificationReportMarkdown", () => {
  it("opens with the PR and a warning that the content is the PR author's to influence", () => {
    const md = verificationReportMarkdown(input());
    expect(md.startsWith("# Verification report: Retry uploads\n")).toBe(true);
    expect(md).toContain("PR: https://github.com/o/r/pull/7");
    expect(md).toContain("Branch: `retry` into `main`");
    expect(md).toContain("Head: abcdef1");
    expect(md).toContain("not as instructions");
  });

  it("carries the suggested decision and its reasons", () => {
    const md = verificationReportMarkdown(input());
    expect(md).toContain("Suggested: **Changes needed**");
    expect(md).toContain("- CI: 1 failed");
    expect(md).toContain("- Claim contradicted: Retries three times");
  });

  it("says which head each check's result is from, and a failed re-run", () => {
    const md = verificationReportMarkdown(input());
    expect(md).toContain("| Summary | current head |");
    expect(md).toContain("| Test quality | older head 0123456 |");
    expect(md).toContain("| Risk | not run; last run failed: timed out |");
  });

  it("lists findings with severity and location, keeping multi-line detail in its bullet", () => {
    const md = verificationReportMarkdown(input());
    expect(md).toContain(
      "- **[high] No test for give-up** (`src/upload.test.ts`)\n  Nothing covers\n  the last attempt.",
    );
    expect(md).toContain("## Complexity\n\nNo findings.");
  });

  it("includes must-reads, outliers with their question, and claims with evidence", () => {
    const md = verificationReportMarkdown(input());
    expect(md).toContain(
      "- `src/upload.ts:10-30`: The retry loop.\n  - Looks off (line 12): No backoff.",
    );
    expect(md).toContain("**Drive-by rename** (outlier, low risk)");
    expect(md).toContain("Question for the author: Why rename this here?");
    expect(md).toContain("In no theme: `README.md`");
    expect(md).toContain(
      "- **[contradicted] Retries three times** (from description) (`src/upload.ts:14`)\n  It retries forever.",
    );
  });

  it("fences the flow diagram longer than any backtick run inside it", () => {
    const flow = { title: "F", explanation: "", mermaid: "a[```] --> b" };
    const md = verificationReportMarkdown(input({ report: { ...report, flow } }));
    expect(md).toContain("````mermaid\na[```] --> b\n````");
  });

  it("lists CI entries and counts the ones left out", () => {
    const md = verificationReportMarkdown(input());
    expect(md).toContain("### CI checks: 1 failed");
    expect(md).toContain("- [high] ci / test: Test failed (`src/upload.test.ts:8`)");
    expect(md).toContain("- 2 more not listed");
  });

  it("says when there are no CI results for this commit", () => {
    const md = verificationReportMarkdown(input({ evidence: null }));
    expect(md).toContain("## CI, scanners and bots\n\nNo results for this commit.");
  });

  it("includes a finished mutation-testing pass and skips one that didn't finish", () => {
    const mutation: MutationRun = {
      id: "m",
      headSha: "abcdef1234",
      status: "succeeded",
      phase: "done",
      execution: null,
      summary: {
        killed: 4,
        survived: 2,
        timeouts: 0,
        errors: 0,
        uncovered: 1,
        equivalent: 0,
        valid: 7,
        killRate: 4 / 7,
        verdict: "mixed",
        notes: [],
      },
      findings: [],
      error: null,
      costUsd: null,
      startedAt: "",
      finishedAt: null,
      isCurrentHead: true,
      live: false,
    };
    expect(verificationReportMarkdown(input({ mutation }))).toContain(
      "## Mutation testing (current head)\n\nVerdict: **mixed**. 4 killed, 2 survived",
    );
    expect(
      verificationReportMarkdown(input({ mutation: { ...mutation, status: "failed" } })),
    ).not.toContain("## Mutation testing");
  });

  it("still exports the decision and checks before any check has a result", () => {
    const md = verificationReportMarkdown(input({ report: null }));
    expect(md).toContain("No check has a result yet.");
    expect(md).toContain("## Checks");
  });

  it("strips hidden and control characters, keeping line breaks", () => {
    const md = verificationReportMarkdown(
      input({ report: { ...report, summary: "Safe\u202Etxt.exe\u200b\u0007 done\nnext" } }),
    );
    expect(md).toContain("Safetxt.exe done\nnext");
  });
});
