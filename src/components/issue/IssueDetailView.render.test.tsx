import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { IssueDetail, IssueSummary } from "../../lib/issues/types";
import { renderToHtml } from "../../test/render";
import IssueDetailView from "./IssueDetailView";

const summary = (state: string): IssueSummary => ({
  provider: "github",
  sourceKey: "octo/web",
  sourceLabel: "octo/web",
  externalId: "7",
  displayId: "#7",
  title: "Broken login",
  url: "https://github.com/octo/web/issues/7",
  state,
  author: "alice",
  assignees: [],
  labels: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  commentCount: 0,
});

const detail = (state: string): IssueDetail => ({
  ...summary(state),
  body: "the body",
  comments: [],
});

// The detail fetch is the only sidecar call this view makes on mount.
mock.module("../../lib/issues/api", () => ({
  issueDetail: async () => detail("closed"),
  startWork: async () => ({ workspaceId: "ws-1", prompt: "p", warnings: [] }),
  updateIssue: async () => detail("closed"),
}));

describe("IssueDetailView", () => {
  it("offers Reopen once the loaded detail reports a closed issue", async () => {
    // The summary still says "open" (the list was fetched before the close), so
    // this also pins that the header follows the freshly loaded detail.
    const html = await renderToHtml(
      createElement(IssueDetailView, { summary: summary("open"), onBack: () => {} }),
    );
    expect(html).toContain("Reopen issue");
    expect(html).not.toContain("Close issue");
  });

  it("renders edit affordances for the title and description", async () => {
    const html = await renderToHtml(
      createElement(IssueDetailView, { summary: summary("open"), onBack: () => {} }),
    );
    expect(html).toContain("Edit title");
    expect(html).toContain("Edit description");
  });
});
