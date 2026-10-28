import { describe, expect, it } from "bun:test";
import { findingCommentBody } from "./verification";

describe("findingCommentBody", () => {
  it("names the report and section so the comment isn't read as the reviewer's own words", () => {
    expect(
      findingCommentBody(
        { title: "Eviction is untested", detail: "Nothing covers a full cache.", severity: "high" },
        "Test quality",
      ),
    ).toBe(
      "**Eviction is untested** (verification report: Test quality, high)\n\nNothing covers a full cache.",
    );
  });

  it("leaves out the severity a risk concern doesn't have", () => {
    expect(findingCommentBody({ title: "Stale reads", detail: "Edits stay stale." }, "Risk")).toBe(
      "**Stale reads** (verification report: Risk)\n\nEdits stay stale.",
    );
  });
});
