import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { WorkspaceDetail } from "../../lib/workspaces";
import { renderToHtml } from "../../test/render";
import ArchiveDialog from "./ArchiveDialog";

const detail = (over: Partial<WorkspaceDetail> = {}) =>
  ({
    id: "ws-1",
    name: "Workspace",
    status: "active",
    summary: null,
    mergedPrUrl: null,
    error: null,
    repos: [],
    tasks: [],
    issues: [],
    ...over,
  }) as unknown as WorkspaceDetail;

const render = (d: WorkspaceDetail) =>
  renderToHtml(
    createElement(ArchiveDialog, {
      detail: d,
      onClose: () => {},
      onArchived: async () => {},
      onError: () => {},
    }),
  );

describe("ArchiveDialog", () => {
  it("offers a plain Archive and says the teardown runs in the background", async () => {
    const html = await render(detail());
    expect(html).toContain("Archive");
    expect(html).toContain("Runs in the background");
    expect(html).not.toContain("Force remove");
  });

  it("offers Force remove with the repo's error once an archive is blocked", async () => {
    const html = await render(
      detail({
        status: "archiving",
        error: "one or more worktrees could not be removed",
        repos: [
          {
            id: "wr-1",
            status: "error",
            error: "worktree contains modified files",
            repo: { name: "widget" },
          },
        ] as unknown as WorkspaceDetail["repos"],
      }),
    );
    expect(html).toContain("Force remove");
    expect(html).toContain("widget: worktree contains modified files");
  });

  it("lists the linked issues not yet done, ticked to close", async () => {
    const issue = (externalId: string, localStatus: string, provider = "github") => ({
      id: `link-${externalId}`,
      provider,
      sourceKey: provider === "jira" ? "PROJ" : "acme/widget",
      externalId,
      title: `Issue ${externalId}`,
      localStatus,
    });
    const html = await render(
      detail({
        issues: [
          issue("12", "in_progress"),
          issue("PROJ-4", "todo", "jira"),
          issue("13", "done"),
        ] as unknown as WorkspaceDetail["issues"],
      }),
    );
    expect(html).toContain("Close linked issues");
    expect(html).toContain("acme/widget#12");
    expect(html).toContain("PROJ-4");
    expect(html).not.toContain("Issue 13");
    expect(html.match(/type="checkbox"[^>]*checked/g)?.length).toBe(2);
  });

  it("shows no issue list when nothing is linked", async () => {
    const html = await render(detail());
    expect(html).not.toContain("Close linked issues");
  });
});
