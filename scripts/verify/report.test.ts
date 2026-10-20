import { describe, expect, it } from "bun:test";
import type { Facts } from "./collect.ts";
import {
  coverageStatus,
  finalVerdict,
  inline,
  parseReportData,
  REPORT_MARKER,
  Review,
  renderReport,
} from "./report.ts";

const pass = { status: "pass" as const, note: "fine" };

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    goal: "Let the workspace list be resized",
    summary: "Adds a drag handle to the workspace list divider.",
    verdict: "auto",
    verdictReason: "Small, tested, UI only.",
    dimensions: {
      goal: pass,
      tests: pass,
      reliability: pass,
      security: pass,
      complexity: pass,
      maintainability: pass,
      ui: pass,
    },
    findings: [],
    screenshots: [],
    reviewers: ["security-privacy-reviewer"],
    model: "claude-opus-5-5",
    ...overrides,
  };
}

function makeFacts(overrides: Partial<Facts> = {}): Facts {
  return {
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: [{ path: "src/components/List.tsx", additions: 40, deletions: 2 }],
    tier: { tier: "low", reasons: [] },
    coverage: {
      changedLines: 20,
      coveredLines: 18,
      ratio: 0.9,
      uncovered: [],
      notLoaded: [],
      unmeasured: [],
    },
    baseline: { detecting: 3, notDetecting: [], failingOnHead: [] },
    suites: ["frontend"],
    ...overrides,
  };
}

describe("finalVerdict", () => {
  it("keeps an auto verdict for a clean low-risk PR", () => {
    expect(finalVerdict(makeReview(), makeFacts()).verdict).toBe("auto");
  });

  it("never lets the reviewer's verdict be looser than the risk tier", () => {
    const facts = makeFacts({ tier: { tier: "high", reasons: ["dependencies (bun.lock)"] } });
    expect(finalVerdict(makeReview(), facts)).toEqual({
      verdict: "human",
      why: ["high-risk change"],
    });
    expect(
      finalVerdict(makeReview(), makeFacts({ tier: { tier: "standard", reasons: [] } })).verdict,
    ).toBe("agent");
  });

  it("needs an agent for a major finding and a human for a blocker", () => {
    const finding = (severity: "major" | "blocker") =>
      makeReview({ findings: [{ severity, title: "Leaks a listener", detail: "…" }] });
    expect(finalVerdict(finding("major"), makeFacts()).verdict).toBe("agent");
    expect(finalVerdict(finding("blocker"), makeFacts()).verdict).toBe("human");
  });

  it("needs an agent for a concern and a human for a failed check", () => {
    const withSecurity = (status: "concern" | "fail") =>
      makeReview({ dimensions: { ...makeReview().dimensions, security: { status, note: "XSS" } } });
    expect(finalVerdict(withSecurity("concern"), makeFacts()).verdict).toBe("agent");
    expect(finalVerdict(withSecurity("fail"), makeFacts()).verdict).toBe("human");
  });

  it("follows diff coverage", () => {
    const at = (ratio: number) => makeFacts({ coverage: { ...makeFacts().coverage, ratio } });
    expect(finalVerdict(makeReview(), at(0.6)).verdict).toBe("agent");
    expect(finalVerdict(makeReview(), at(0.2)).verdict).toBe("human");
  });

  const mutation = (killed: number, survivedCount: number) => ({
    score: killed / (killed + survivedCount),
    killed,
    survived: Array.from({ length: survivedCount }, (_, i) => `src/a.ts:${i + 1} BlockStatement`),
    skippedRanges: 0,
  });

  it("needs an agent when the tests miss many mutations on the changed lines", () => {
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(5, 5) })).verdict).toBe(
      "agent",
    );
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(6, 4) })).verdict).toBe(
      "auto",
    );
  });

  it("doesn't judge the tests on too few mutants", () => {
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(1, 3) })).verdict).toBe(
      "auto",
    );
  });

  it("needs a human when tests fail on the PR", () => {
    const facts = makeFacts({
      baseline: { detecting: 0, notDetecting: [], failingOnHead: ["a.test.ts > x"] },
    });
    expect(finalVerdict(makeReview(), facts).verdict).toBe("human");
  });

  it("only ever tightens when several limits apply", () => {
    const review = makeReview({ findings: [{ severity: "blocker", title: "x", detail: "…" }] });
    const facts = makeFacts({ tier: { tier: "standard", reasons: [] } });
    expect(finalVerdict(review, facts).verdict).toBe("human");
  });

  it("can be made stricter by the reviewer", () => {
    expect(finalVerdict(makeReview({ verdict: "human" }), makeFacts()).verdict).toBe("human");
  });
});

describe("renderReport", () => {
  it("round-trips its data block through the comment body", () => {
    const { body, data } = renderReport(makeReview(), makeFacts());
    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(parseReportData(body)).toEqual(data);
  });

  it("lists failing checks, including coverage, in the data the gate reads", () => {
    const review = makeReview({
      dimensions: { ...makeReview().dimensions, tests: { status: "concern", note: "thin" } },
    });
    const facts = makeFacts({ coverage: { ...makeFacts().coverage, ratio: 0.2 } });
    expect(renderReport(review, facts).data.flagged).toEqual(["tests", "coverage"]);
  });

  it("shows the mutation score with the tests and lists surviving mutants in details", () => {
    const facts = makeFacts({
      mutation: {
        score: 0.5,
        killed: 5,
        survived: [
          "src/a.ts:10 BlockStatement",
          "src/a.ts:9 BlockStatement",
          "src/a.ts:1 X",
          "src/a.ts:2 X",
          "src/a.ts:3 X",
        ],
        skippedRanges: 2,
      },
    });
    const { body, data } = renderReport(makeReview(), facts);
    expect(body).toContain("50% of 10 mutants on changed lines caught (2 ranges not mutated)");
    const details = body.split("<details>")[1];
    // Numeric order, so line 9 comes before line 10.
    expect(details.indexOf("src/a.ts:9 ")).toBeLessThan(details.indexOf("src/a.ts:10 "));
    expect(data.flagged).toContain("mutation");
  });

  it("says nothing about mutation when no mutant ran", () => {
    const facts = makeFacts({
      mutation: { score: null, killed: 0, survived: [], skippedRanges: 0 },
    });
    const { body, data } = renderReport(makeReview(), facts);
    expect(body).not.toContain("mutants");
    expect(data.flagged).not.toContain("mutation");
  });

  it("keeps minor findings out of the headline section", () => {
    const review = makeReview({
      verdict: "agent",
      findings: [
        { severity: "major", title: "Races on unmount", detail: "…" },
        { severity: "minor", title: "Rename a variable", detail: "…" },
      ],
    });
    const { body } = renderReport(review, makeFacts());
    const [headline, details] = body.split("<details>");
    expect(headline).toContain("Races on unmount");
    expect(headline).not.toContain("Rename a variable");
    expect(details).toContain("Rename a variable");
  });
});

describe("coverageStatus", () => {
  const coverage = (ratio: number | null, notLoaded: string[] = []) => ({
    ...makeFacts().coverage,
    ratio,
    notLoaded,
  });

  it("passes at 80% and fails below 50%", () => {
    expect(coverageStatus(coverage(0.8))).toBe("pass");
    expect(coverageStatus(coverage(0.5))).toBe("concern");
    expect(coverageStatus(coverage(0.49))).toBe("fail");
  });

  it("flags changed files no test loads, which the ratio can't see", () => {
    expect(coverageStatus(coverage(1, ["src/new.ts"]))).toBe("concern");
    expect(coverageStatus(coverage(null, ["src/new.ts"]))).toBe("fail");
  });

  it("has nothing to say when no executable line changed", () => {
    expect(coverageStatus(coverage(null))).toBe("n/a");
  });
});

describe("inline", () => {
  it("leaves no HTML tag or comment able to open", () => {
    expect(inline("a <!-- yarvis-verify-data x --> <b>b</b> & c")).toBe(
      "a &lt;!-- yarvis-verify-data x --&gt; &lt;b&gt;b&lt;/b&gt; &amp; c",
    );
  });

  it("escapes backslashes, so one can't cancel the pipe escape", () => {
    expect(inline("a\\|b")).toBe("a\\\\\\|b");
  });

  it("keeps text from breaking the table or pinging people", () => {
    expect(inline("a | b\nc @someone")).toBe("a \\| b c @​someone");
  });
});

describe("Review", () => {
  it("only accepts screenshots that are absolute image paths", () => {
    const withShot = (path: string) =>
      Review.safeParse({ ...makeReview(), screenshots: [{ path, caption: "x" }] }).success;
    expect(withShot("/tmp/verify/7/after.png")).toBe(true);
    expect(withShot("/Users/me/.ssh/id_ed25519")).toBe(false);
    expect(withShot("after.png")).toBe(false);
  });
});

describe("parseReportData", () => {
  it("returns null for a comment without a data block or with a broken one", () => {
    expect(parseReportData(`${REPORT_MARKER}\nhand-written`)).toBeNull();
    expect(parseReportData("<!-- yarvis-verify-data bm90IGpzb24= -->")).toBeNull();
  });
});
