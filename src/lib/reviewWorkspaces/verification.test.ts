import { describe, expect, it } from "bun:test";
import { findingCommentBody } from "./verification";

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

  it("keeps the title to one line, so a command in it can't start a line", () => {
    const body = findingCommentBody({ title: "Stale\n/approve  now\n", detail: "Fine." }, "Risk");
    expect(body.split("\n")[0]).toBe("**Stale /approve now** (verification report: Risk)");
  });
});
