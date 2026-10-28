import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SECTIONS,
  findingCommentBody,
  runSections,
  sizeFor,
  type VerificationSize,
} from "./verification";

describe("findingCommentBody", () => {
  it("names the report and section, and quotes what it said", () => {
    expect(
      findingCommentBody(
        { title: "Eviction is untested", detail: "Nothing covers a full cache.", severity: "high" },
        "Test quality",
      ),
    ).toBe(
      "**Eviction is untested** (verification report: Test quality, high)\n\n> Nothing covers a full cache.",
    );
  });

  it("leaves out the severity a risk concern doesn't have", () => {
    expect(findingCommentBody({ title: "Stale reads", detail: "Edits stay stale." }, "Risk")).toBe(
      "**Stale reads** (verification report: Risk)\n\n> Edits stay stale.",
    );
  });

  it("keeps a bot command or mention in the text from acting under the reviewer's name", () => {
    const body = findingCommentBody(
      { title: "Ping @octocat", detail: "Fine.\n/approve\n@dependabot merge" },
      "Risk",
    );
    // Every line of the detail is quoted, so none starts with a command.
    expect(body.split("\n").slice(2)).toEqual([
      "> Fine.",
      "> /approve",
      "> @\u200bdependabot merge",
    ]);
    expect(body).not.toMatch(/@[a-z]/);
  });
});

describe("runSections", () => {
  it("reads a run's sections in report order, and the default for a run that recorded none", () => {
    expect(runSections({ sections: ["flow", "tests"] })).toEqual(["tests", "flow"]);
    expect(runSections({})).toEqual(DEFAULT_SECTIONS);
    expect(runSections(undefined)).toEqual(DEFAULT_SECTIONS);
  });
});

describe("sizeFor", () => {
  const size: VerificationSize = {
    files: 3,
    changedLines: 30,
    large: false,
    binary: [],
    truncated: [],
    skimmed: [],
    estimatedCostUsd: 0.5,
    sectionCostUsd: 0.04,
    defaultSections: [...DEFAULT_SECTIONS],
    budgetUsd: 0.52,
    overBudget: false,
  };

  it("moves the estimate by each section added or dropped, and re-weighs the budget", () => {
    const more = sizeFor(size, [...DEFAULT_SECTIONS, "flow"]);
    expect(more.estimatedCostUsd).toBe(0.54);
    expect(more.overBudget).toBe(true);
    expect(sizeFor(size, ["tests"]).estimatedCostUsd).toBe(0.22);
  });

  it("never goes below zero", () => {
    expect(sizeFor({ ...size, sectionCostUsd: 1 }, ["tests"]).estimatedCostUsd).toBe(0);
  });
});
