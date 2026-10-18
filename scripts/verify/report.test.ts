import { describe, expect, it } from "bun:test";
import type { Facts } from "./collect.ts";
import {
  finalVerdict,
  parseReportData,
  REPORT_MARKER,
  type Review,
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
    baseline: { detecting: 3, notDetecting: [], failingOnHead: [], unmeasured: [] },
    suites: ["frontend"],
    ...overrides,
  };
}

describe("finalVerdict", () => {
  it("keeps an auto verdict for a clean low-risk PR", () => {
    expect(finalVerdict(makeReview(), makeFacts()).verdict).toBe("auto");
  });

  it("never lets the reviewer's verdict be looser than the risk tier", () => {
    const facts = makeFacts({ tier: { tier: "high", reasons: ["high: dependencies (bun.lock)"] } });
    expect(finalVerdict(makeReview(), facts)).toEqual({
      verdict: "human",
      why: ["high-risk change"],
    });
    expect(
      finalVerdict(makeReview(), makeFacts({ tier: { tier: "standard", reasons: [] } })).verdict,
    ).toBe("agent");
  });

  it("caps on findings, failed checks and low coverage", () => {
    const major = makeReview({
      findings: [{ severity: "major", title: "Leaks a listener", detail: "…" }],
    });
    expect(finalVerdict(major, makeFacts()).verdict).toBe("agent");

    const failing = makeReview({
      dimensions: { ...makeReview().dimensions, security: { status: "fail", note: "XSS" } },
    });
    expect(finalVerdict(failing, makeFacts()).verdict).toBe("human");

    const lowCoverage = makeFacts({ coverage: { ...makeFacts().coverage, ratio: 0.6 } });
    expect(finalVerdict(makeReview(), lowCoverage).verdict).toBe("agent");
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
    expect(renderReport(review, facts).data.failing).toEqual(["tests", "coverage"]);
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

describe("parseReportData", () => {
  it("returns null for a comment without a data block or with a broken one", () => {
    expect(parseReportData(`${REPORT_MARKER}\nhand-written`)).toBeNull();
    expect(parseReportData("<!-- yarvis-verify-data bm90IGpzb24= -->")).toBeNull();
  });
});
