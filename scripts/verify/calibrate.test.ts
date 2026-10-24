import { describe, expect, it } from "bun:test";
import { findEscapes, latestReport, type Outcome, outcomeFor, summarize } from "./calibrate.ts";
import { REPORT_MARKER, type ReportData } from "./report.ts";

const pr = (number: number, body = "", headSha = "head") => ({
  number,
  title: `PR ${number}`,
  body,
  headSha,
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

  it("counts a fix PR once when it both reverts and names the regression", () => {
    const escapes = findEscapes(
      [pr(10, "Reverts bennettaur/yarvis#3\n\nRegression-from: #3")],
      "bennettaur/yarvis",
    );
    expect(escapes.get(3)).toEqual([10]);
  });
});

const data = (verdict: ReportData["verdict"], headSha = "head"): ReportData => ({
  version: 2,
  repo: "bennettaur/yarvis",
  pr: 1,
  headSha,
  verdict,
  riskTier: "low",
  blockers: 0,
  majors: 0,
  flagged: [],
  model: "claude-opus-5-5",
});

function reportBody(report: ReportData) {
  const block = Buffer.from(JSON.stringify(report)).toString("base64");
  return `${REPORT_MARKER}\n<!-- yarvis-verify-data ${block} -->\n<!-- yarvis-verify-sig c2ln -->`;
}

function reportComment(authorId: number | null, report: ReportData) {
  return { body: reportBody(report), authorId };
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

  it("never trusts a bot or app, which has no user ID", () => {
    expect(latestReport([reportComment(null, data("auto"))], [1])).toBeNull();
  });
});

describe("outcomeFor", () => {
  const review = (body: string, botAuthor: boolean, authorAssociation = "NONE") => ({
    state: "APPROVED",
    body,
    authorAssociation,
    author: { __typename: botAuthor ? "Bot" : "User" },
  });
  const node = (reviews: ReturnType<typeof review>[]) => ({
    number: 1,
    title: "PR 1",
    body: "",
    headRefOid: "head",
    comments: { nodes: [{ body: reportBody(data("auto")), author: { databaseId: 7 } }] },
    reviews: { nodes: reviews },
  });

  it("reads the trusted report and the bot's approval", () => {
    const outcome = outcomeFor(node([review("Auto-approved: passed.", true)]), [7], []);
    expect(outcome.report?.verdict).toBe("auto");
    expect(outcome.path).toBe("auto");
  });

  it("doesn't take a person's review as the bot's, whatever it says", () => {
    expect(outcomeFor(node([review("Auto-approved: passed.", false)]), [7], []).path).toBe("none");
  });

  it("counts a maintainer's approval, but not an outsider's", () => {
    expect(outcomeFor(node([review("LGTM", false, "OWNER")]), [7], []).path).toBe("human");
    expect(outcomeFor(node([review("LGTM", false, "NONE")]), [7], []).path).toBe("none");
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

  it("leaves the reverts and fixes themselves out of the tallies", () => {
    const text = summarize(
      [outcome({ escapedVia: [9] }), outcome({ pr: pr(9), report: null, path: "human" })],
      30,
    );
    expect(text).toContain("| auto | 1 | 1 | 100% |");
    expect(text).not.toContain("no report");
  });

  it("splits by reviewing model only when more than one reviewed", () => {
    const other = { ...data("auto"), model: "claude-sonnet-5-5" };
    expect(summarize([outcome({})], 30)).not.toContain("By reviewing model");
    expect(summarize([outcome({}), outcome({ pr: pr(2), report: other })], 30)).toContain(
      "| claude-sonnet-5-5 | 1 | 0 | 0% |",
    );
  });

  it("counts escapes by the report's risk tier, to show when the assessment let one through", () => {
    const text = summarize(
      [
        outcome({ escapedVia: [9] }),
        outcome({ pr: pr(2), report: { ...data("agent"), riskTier: "standard" } }),
      ],
      30,
    );
    expect(text).toContain("### By risk tier");
    expect(text).toContain("| low | 1 | 1 | 100% |");
    expect(text).toContain("| standard | 1 | 0 | 0% |");
  });

  it("doesn't credit a verdict given for an older commit", () => {
    const text = summarize([outcome({ report: data("auto", "old") })], 30);
    expect(text).toContain("| stale report | 1 | 0 | 0% |");
  });
});
