import { describe, expect, it } from "bun:test";
import type { WorkspaceSummaryPr } from "../../lib/workspaces";
import { renderToHtml } from "../../test/render";
import WorkspacePrBadges from "./WorkspacePrBadges";

const PR: WorkspaceSummaryPr = {
  repoName: "web",
  prNumber: 12,
  prState: "open",
  isDraft: false,
  mergeable: "clean",
  checkRollup: "success",
  reviewDecision: "approved",
};

describe("WorkspacePrBadges", () => {
  it("badges every repo's PR, so one failing repo isn't hidden by a passing one", async () => {
    const html = await renderToHtml(
      <WorkspacePrBadges
        prs={[PR, { ...PR, repoName: "api", prNumber: 3, checkRollup: "failure" }]}
      />,
    );

    expect(html).toContain("web #12 ready to merge");
    expect(html).toContain("api #3 checks failing");
  });

  it("separates a PR held behind a merge rule from one ready to merge", async () => {
    const html = await renderToHtml(
      <WorkspacePrBadges
        prs={[PR, { ...PR, repoName: "api", prNumber: 3, mergeable: "blocked" }]}
      />,
    );

    expect(html).toContain("web #12 ready to merge");
    expect(html).toContain("api #3 approved");
    expect(html).toContain("★");
    expect(html).toContain("✓");
  });

  it("renders nothing for a workspace with no PR yet", async () => {
    expect(await renderToHtml(<WorkspacePrBadges prs={[]} />)).toBe("");
  });
});
