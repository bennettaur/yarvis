import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { ReviewCommit } from "../../../lib/reviewWorkspaces/sinceReview";
import { mountForInteraction } from "../../../test/render";
import type { TabSpec } from "../tabs/types";
import CommitsList from "./CommitsList";

const commit = (c: string, isNew: boolean): ReviewCommit => ({
  sha: c.repeat(40),
  subject: `subject ${c}`,
  author: "octo",
  date: "2026-10-01T00:00:00Z",
  parents: [],
  isNew,
});

let unmount = () => {};
afterEach(() => unmount());

describe("CommitsList", () => {
  it("marks the commits new since the review and opens one as a commit tab", async () => {
    const opened: TabSpec[] = [];
    const mounted = await mountForInteraction(
      createElement(CommitsList, {
        prId: "pr1",
        commits: [commit("b", true), commit("a", false)],
        truncated: false,
        activeSha: null,
        openTab: (spec) => opened.push(spec),
      }),
    );
    unmount = mounted.unmount;
    const rows = [...mounted.host.querySelectorAll("button")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("new since your last review");
    expect(rows[1]?.textContent).not.toContain("new since your last review");
    rows[0]?.click();
    expect(opened).toEqual([
      { kind: "commit", prId: "pr1", sha: "b".repeat(40), subject: "subject b" },
    ]);
  });
});
