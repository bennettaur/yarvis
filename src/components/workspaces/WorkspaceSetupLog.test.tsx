import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { WorkspaceRepoDetail } from "../../lib/workspaces";
import { renderToHtml } from "../../test/render";
import WorkspaceSetupLog from "./WorkspaceSetupLog";

const baseRepo: WorkspaceRepoDetail = {
  id: "wr1",
  workspaceId: "ws1",
  repoId: "r1",
  status: "error",
  branch: "yarvis/thing",
  baseBranch: "main",
  worktreePath: "/work/ws1/thing",
  setupLog: "$ bun install\nerror: script failed",
  setupExitCode: 1,
  error: "setup script exited 1",
  createdAt: "2026-01-01T00:00:00Z",
  repo: {
    id: "r1",
    name: "thing",
    owner: "octo",
    repo: "thing",
    cloneUrl: "git@github.com:octo/thing.git",
    primaryClonePath: "/work/.repos/octo-thing",
    defaultBranch: "main",
    setupScript: "bun install",
    runScript: null,
    pullIssues: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  pr: null,
};

const render = (repo: WorkspaceRepoDetail) =>
  renderToHtml(createElement(WorkspaceSetupLog, { repo }));

describe("WorkspaceSetupLog", () => {
  it("shows the captured setup output, exit code, and error for a failed repo", async () => {
    const html = await render(baseRepo);
    expect(html).toContain("error: script failed");
    expect(html).toContain("setup script exited 1");
    expect(html).toContain("thing");
  });

  // A repo that failed before running setup (e.g. a clone/worktree error) has an
  // error but no captured log — the placeholder stands in so the tab isn't blank.
  it("falls back to a placeholder when no setup output was captured", async () => {
    const html = await render({
      ...baseRepo,
      setupLog: null,
      setupExitCode: null,
      error: "could not create worktree",
    });
    expect(html).toContain("No setup output was captured.");
    expect(html).toContain("could not create worktree");
    // With no exit code, the header falls back to the generic failure label.
    expect(html).toContain("provisioning failed");
  });
});
