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

    expect(html).toContain("web #12 approved");
    expect(html).toContain("api #3 checks failing");
  });

  it("renders nothing for a workspace with no PR yet", async () => {
    expect(await renderToHtml(<WorkspacePrBadges prs={[]} />)).toBe("");
  });
});
