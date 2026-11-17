import { afterAll, describe, expect, it } from "bun:test";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";
import {
  changedUpstack,
  findingCommentBody,
  type VerificationUpstack,
  verificationChecklist,
} from "./verification";

afterAll(resetSidecarApi);

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

describe("verificationChecklist", () => {
  const answer = (report: unknown) =>
    stubSidecarApi({
      sidecarFetch: async () =>
        new Response(JSON.stringify({ headSha: "h", themes: [], items: [], report, size: null })),
    });

  it("gives a report with no summary result an empty must-read list", async () => {
    answer({ tests: { status: "pass", findings: [] } });
    const { report } = await verificationChecklist("ws", "pr");
    expect(report).toEqual({ tests: { status: "pass", findings: [] }, mustRead: [] });
  });

  it("passes a missing report through as none", async () => {
    answer(null);
    expect((await verificationChecklist("ws", "pr")).report).toBeNull();
  });
});

describe("changedUpstack", () => {
  const upstack: VerificationUpstack = {
    headSha: "h",
    note: null,
    layers: [
      {
        number: 8,
        url: "u8",
        incomplete: false,
        files: [
          { path: "src/a.ts", ranges: [{ start: 10, end: 12 }] },
          { path: "src/gone.ts", ranges: null },
        ],
      },
    ],
  };
  const layer = { number: 8, url: "u8" };

  it("names the layer that changes a finding's line, or one a few lines off", () => {
    expect(changedUpstack(upstack, "src/a.ts", 11)).toMatchObject(layer);
    expect(changedUpstack(upstack, "src/a.ts", 15)).toMatchObject(layer);
    expect(changedUpstack(upstack, "src/a.ts", 16)).toBeNull();
  });

  it("counts any line of a file the layer replaces, and a finding with no line in a changed file", () => {
    expect(changedUpstack(upstack, "src/gone.ts", 300)).toMatchObject(layer);
    expect(changedUpstack(upstack, "src/a.ts", undefined)).toMatchObject(layer);
  });

  it("finds nothing without a path, a matching file or any layers", () => {
    expect(changedUpstack(upstack, undefined, 11)).toBeNull();
    expect(changedUpstack(upstack, "src/b.ts", 11)).toBeNull();
    expect(changedUpstack(null, "src/a.ts", 11)).toBeNull();
  });
});
