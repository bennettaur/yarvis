import { describe, expect, it } from "bun:test";
import { findEscapes, latestReport, mergePath, type Outcome, summarize } from "./calibrate.ts";
import { REPORT_MARKER, type ReportData } from "./report.ts";

const pr = (number: number, body = "", headSha = "head") => ({
  number,
  title: `PR ${number}`,
  body,
  headSha,
});

describe("mergePath", () => {
  it("tells the bot's two kinds of approval from a person's", () => {
    const approved = (body: string) => [{ state: "APPROVED", body }];
    expect(mergePath(approved("Auto-approved: the verification report for abc passed."))).toBe(
      "auto",
    );
    expect(mergePath(approved("Approved by @bennettaur with /approve at abc."))).toBe("/approve");
    expect(mergePath(approved("LGTM"))).toBe("human");
  });

  it("ignores reviews that didn't approve", () => {
    expect(mergePath([{ state: "COMMENTED", body: "Auto-approved: no" }])).toBe("none");
  });
});

describe("findEscapes", () => {
  it("reads GitHub's revert line and the regression convention", () => {
    const escapes = findEscapes(
      [
        pr(10, "Reverts bennettaur/yarvis#3\n\nCI broke."),
        pr(11, "Fixes the crash.\n\nRegression-from: #4"),
        pr(12, "Regression-from: #4"),
      ],
      "bennettaur/yarvis",
    );
    expect(escapes.get(3)).toEqual([10]);
    expect(escapes.get(4)).toEqual([11, 12]);
  });

  it("ignores reverts in another repo and mentions in passing", () => {
    const escapes = findEscapes(
      [pr(10, "Reverts other/repo#3"), pr(11, "Unlike #4, this has no Regression-from: #4 line")],
      "bennettaur/yarvis",
    );
    expect(escapes.size).toBe(0);
  });
});

const data = (verdict: ReportData["verdict"], headSha = "head"): ReportData => ({
  version: 1,
  headSha,
  verdict,
  blockers: 0,
  majors: 0,
  flagged: [],
  model: "claude-opus-5-5",
});

function reportComment(id: number, report: ReportData) {
  const block = Buffer.from(JSON.stringify(report)).toString("base64");
  return {
    id,
    body: `${REPORT_MARKER}\n<!-- yarvis-verify-data ${block} -->`,
    html_url: "",
    user: { login: "x", id },
  };
}

describe("latestReport", () => {
  it("takes the newest report from a trusted user", () => {
    const comments = [
      reportComment(1, data("human")),
      reportComment(1, data("auto")),
      reportComment(2, data("agent")),
    ];
    expect(latestReport(comments, [1])?.verdict).toBe("auto");
  });
});

describe("summarize", () => {
  const outcome = (o: Partial<Outcome>): Outcome => ({
    pr: pr(1),
    report: data("auto"),
    path: "auto",
    escapedVia: [],
    ...o,
  });

  it("counts escapes per verdict and lists them", () => {
    const text = summarize(
      [
        outcome({}),
        outcome({ pr: pr(2), escapedVia: [9] }),
        outcome({ pr: pr(3), report: data("agent"), path: "/approve" }),
      ],
      30,
    );
    expect(text).toContain("| auto | 2 | 1 | 50% |");
    expect(text).toContain("| agent | 1 | 0 | 0% |");
    expect(text).toContain("- #2 PR 2: auto, auto, fixed by #9");
  });

  it("doesn't credit a verdict given for an older commit", () => {
    const text = summarize([outcome({ report: data("auto", "old") })], 30);
    expect(text).toContain("| stale report | 1 | 0 | 0% |");
  });
});
