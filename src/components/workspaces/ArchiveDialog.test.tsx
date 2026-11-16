import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { ArchiveWorkspaceInput, WorkspaceDetail } from "../../lib/workspaces";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../test/render";
import { resetWorkspacesApi, stubWorkspacesApi } from "../../test/workspacesApi";

const archiveCalls: ArchiveWorkspaceInput[] = [];
stubWorkspacesApi({
  archiveWorkspace: async (_id: string, input: ArchiveWorkspaceInput = {}) => {
    archiveCalls.push(input);
    return { status: "archiving", errors: [], completedTasks: 0 };
  },
});
afterAll(resetWorkspacesApi);

const { default: ArchiveDialog } = await import("./ArchiveDialog");

const issue = (externalId: string, localStatus: string, provider = "github") => ({
  id: `link-${externalId}`,
  provider,
  sourceKey: provider === "jira" ? "PROJ" : provider === "azure" ? "org/project" : "acme/widget",
  externalId,
  title: `Issue ${externalId}`,
  localStatus,
});

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

const dialog = (d: WorkspaceDetail) =>
  createElement(ArchiveDialog, {
    detail: d,
    onClose: () => {},
    onArchived: async () => {},
    onError: () => {},
  });
const render = (d: WorkspaceDetail) => renderToHtml(dialog(d));

let mounted: { host: HTMLElement; unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  archiveCalls.length = 0;
});

/** Mounts the dialog, unticks the issues named, clicks Archive and returns what it sent. */
const submit = async (d: WorkspaceDetail, untick: string[] = []) => {
  mounted = await mountForInteraction(dialog(d));
  const { host } = mounted;
  for (const label of untick) {
    const row = [...host.querySelectorAll("li")].find((li) => li.textContent?.includes(label));
    row?.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  [...host.querySelectorAll("button")].find((b) => b.textContent === "Archive")?.click();
  await waitFor(() => archiveCalls.length > 0, "the archive request");
  return archiveCalls[0]!;
};

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

  it("names an Azure work item by its id and shows no title it doesn't have", async () => {
    const html = await render(
      detail({
        issues: [
          { ...issue("678", "todo", "azure"), title: null },
        ] as unknown as WorkspaceDetail["issues"],
      }),
    );
    expect(textOf(html)).toContain("#678");
    expect(textOf(html)).not.toContain("null");
  });

  it("shows no issue list when every linked issue is already done", async () => {
    const html = await render(
      detail({ issues: [issue("13", "done")] as unknown as WorkspaceDetail["issues"] }),
    );
    expect(html).not.toContain("Close linked issues");
  });

  it("asks to close every unfinished linked issue by default", async () => {
    const sent = await submit(
      detail({
        issues: [
          issue("12", "in_progress"),
          issue("PROJ-4", "todo", "jira"),
          issue("13", "done"),
        ] as unknown as WorkspaceDetail["issues"],
      }),
    );
    expect(sent.closeIssueIds).toEqual(["link-12", "link-PROJ-4"]);
  });

  it("leaves an unticked issue out of the ones to close", async () => {
    const sent = await submit(
      detail({
        issues: [
          issue("12", "in_progress"),
          issue("PROJ-4", "todo", "jira"),
        ] as unknown as WorkspaceDetail["issues"],
      }),
      ["PROJ-4"],
    );
    expect(sent.closeIssueIds).toEqual(["link-12"]);
  });
});
