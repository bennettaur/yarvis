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
});
