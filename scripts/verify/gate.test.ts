import { describe, expect, it } from "bun:test";
import {
  type AutoMergeContext,
  autoMergeBlockers,
  isApproveCommand,
  parseTrusted,
} from "./gate.ts";

function makeContext(overrides: Partial<AutoMergeContext> = {}): AutoMergeContext {
  return {
    data: {
      version: 1,
      headSha: "abc",
      verdict: "auto",
      tier: "low",
      blockers: 0,
      majors: 0,
      failing: [],
      coverage: 0.9,
    },
    headSha: "abc",
    prAuthor: "bennettaur",
    draft: false,
    trusted: ["bennettaur"],
    tier: "low",
    ...overrides,
  };
}

describe("autoMergeBlockers", () => {
  it("allows a current, clean, low-risk report on a maintainer's PR", () => {
    expect(autoMergeBlockers(makeContext())).toEqual([]);
  });

  it("refuses a report for an older commit", () => {
    expect(autoMergeBlockers(makeContext({ headSha: "def" }))).toContain(
      "report is for an older commit",
    );
  });

  it("refuses an outside contributor's PR even with a clean report", () => {
    expect(autoMergeBlockers(makeContext({ prAuthor: "someone" }))).toContain(
      "PR author is not a maintainer",
    );
  });

  it("trusts its own tier over the report's", () => {
    // The report claims low; the gate's own reading of the files says high.
    expect(autoMergeBlockers(makeContext({ tier: "high" }))).toContain("high-risk change");
  });

  it("refuses drafts, non-auto verdicts and reports with concerns", () => {
    const base = makeContext();
    expect(autoMergeBlockers(makeContext({ draft: true }))).toContain("PR is a draft");
    expect(autoMergeBlockers(makeContext({ data: { ...base.data, verdict: "agent" } }))).toContain(
      "verdict is agent",
    );
    expect(
      autoMergeBlockers(makeContext({ data: { ...base.data, failing: ["coverage"] } })),
    ).toContain("concerns: coverage");
  });
});

describe("isApproveCommand", () => {
  it("matches the bare command only", () => {
    expect(isApproveCommand("/approve")).toBe(true);
    expect(isApproveCommand("  /approve \n")).toBe(true);
    expect(isApproveCommand("/approve please, and also delete main")).toBe(false);
    expect(isApproveCommand("I'll /approve later")).toBe(false);
  });
});

describe("parseTrusted", () => {
  it("lowercases and drops empty entries", () => {
    expect(parseTrusted(" BennettAur, ,other ")).toEqual(["bennettaur", "other"]);
    expect(parseTrusted(undefined)).toEqual([]);
  });
});
