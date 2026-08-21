import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChangedFile, WorkspaceRepoDetail } from "../lib/workspaces";
import { clipboardWrites, resetClipboardWrites } from "../test/clipboard";
import { mountForInteraction } from "../test/render";

let files: string[] = [];
let changes: ChangedFile[] = [];

// Only the two worktree readers are stubbed; the rest of the module stays real
// so sibling tests of `lib/workspaces` still see the actual implementations.
const actual = await import("../lib/workspaces");
mock.module("../lib/workspaces", () => ({
  ...actual,
  workspaceRepoFiles: async () => files,
  workspaceRepoChanges: async () => changes,
}));

const { default: WorkspaceSidePanel } = await import("./WorkspaceSidePanel");

const REPO: WorkspaceRepoDetail = {
  id: "wr-1",
  workspaceId: "ws-1",
  repoId: "repo-1",
  status: "ready",
  branch: "feature",
  existingBranch: false,
  baseBranch: "main",
  worktreePath: "/tmp/ws-1/web",
  setupLog: null,
  setupExitCode: null,
  error: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  repo: {
    id: "repo-1",
    name: "web",
    owner: "octo",
    repo: "web",
    cloneUrl: "https://github.com/octo/web.git",
    defaultBranch: "main",
    primaryClonePath: "/tmp/web",
    setupScript: null,
    runScript: null,
    pullIssues: false,
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-06-01T09:00:00.000Z",
  },
  pr: null,
};

/** What the background poller caches for a repo whose branch has a PR. */
const POLLED_PR: NonNullable<WorkspaceRepoDetail["pr"]> = {
  prNumber: 12,
  prUrl: "https://github.com/octo/web/pull/12",
  prState: "open",
  isDraft: false,
  mergeable: "clean",
  checkRollup: "success",
  checks: { total: 2, success: 2, failure: 0, pending: 0 },
  lastPolledAt: "2026-06-01T10:00:00.000Z",
  lastError: null,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

let unmount: (() => void) | null = null;

beforeEach(() => {
  resetClipboardWrites();
  files = ["src/components/a.tsx", "src/components/b.tsx", "README.md"];
  changes = [
    { path: "src/components/a.tsx", status: "modified", additions: 3, deletions: 1 },
    { path: "README.md", status: "added", additions: 9, deletions: 0 },
  ];
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

const mount = async (
  onOpenFile: (repoId: string, path: string) => void = () => {},
  onEditFile: (repoId: string, path: string) => void = () => {},
  repo: WorkspaceRepoDetail = REPO,
) => {
  const mounted = await mountForInteraction(
    <WorkspaceSidePanel
      workspaceId="ws-1"
      repos={[repo]}
      onOpenFile={onOpenFile}
      onEditFile={onEditFile}
    />,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

const clickCopy = async (host: HTMLElement, label: string) => {
  const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!button) throw new Error(`no "${label}" button`);
  button.click();
  await settle();
};

const clickTab = async (host: HTMLElement, label: string) => {
  const tab = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!tab) throw new Error(`no ${label} tab`);
  tab.click();
  await settle();
};

const folderNames = (host: HTMLElement) =>
  [...host.querySelectorAll("details > summary")].map((s) => s.textContent?.replace("▶", ""));

describe("WorkspaceSidePanel", () => {
  // "Changed" is the view the panel opens on.
  it("groups the changed files under folder rows", async () => {
    const host = await mount();
    expect(folderNames(host)).toEqual(["src/components"]);
    expect(
      host.querySelector('details ul [title="Open diff for src/components/a.tsx"]'),
    ).not.toBeNull();
    // Rows show the basename; the full path lives on the row's title.
    expect(host.innerHTML).not.toContain(">src/components/a.tsx<");
  });

  it("opens the diff for a changed file's full path, not its basename", async () => {
    const opened: string[] = [];
    const host = await mount((_repoId, path) => opened.push(path));
    const row = host.querySelector<HTMLButtonElement>(
      '[title="Open diff for src/components/a.tsx"]',
    );
    row?.click();
    expect(opened).toEqual(["src/components/a.tsx"]);
  });

  it("groups every tracked file under folder rows too", async () => {
    const host = await mount();
    await clickTab(host, "All files");
    expect(folderNames(host)).toEqual(["src/components"]);
    expect(host.querySelector('details ul [title="Edit src/components/b.tsx"]')).not.toBeNull();
    expect(host.innerHTML).not.toContain(">src/components/b.tsx<");
  });

  it("opens a tracked file in the editor from the all-files view", async () => {
    const edited: string[] = [];
    const host = await mount(
      () => {},
      (_repoId, path) => edited.push(path),
    );
    await clickTab(host, "All files");
    host.querySelector<HTMLButtonElement>('[title="Edit src/components/b.tsx"]')?.click();
    expect(edited).toEqual(["src/components/b.tsx"]);
  });

  it("offers an editor beside a changed file's diff", async () => {
    const edited: string[] = [];
    const host = await mount(
      () => {},
      (_repoId, path) => edited.push(path),
    );
    host.querySelector<HTMLButtonElement>('[title="Edit src/components/a.tsx"]')?.click();
    expect(edited).toEqual(["src/components/a.tsx"]);
  });

  it("keeps the empty states of both views", async () => {
    files = [];
    changes = [];
    const host = await mount();
    expect(host.textContent).toContain("No changes on this branch.");
    await clickTab(host, "All files");
    expect(host.textContent).toContain("No files.");
  });

  // Both lists show basenames only, so a path leaves the panel through a copy
  // button — and the whole list through the one in the header.
  it("copies each full path and the whole list in both views", async () => {
    const host = await mount();
    expect(host.querySelector('[aria-label="Copy path src/components/a.tsx"]')).not.toBeNull();
    expect(host.textContent).toContain("2 changed files");
    await clickCopy(host, "Copy every path in this list");
    expect(clipboardWrites()).toEqual(["src/components/a.tsx\nREADME.md"]);

    await clickTab(host, "All files");
    expect(host.querySelector('[aria-label="Copy path src/components/b.tsx"]')).not.toBeNull();
    expect(host.textContent).toContain("3 files");
    resetClipboardWrites();
    await clickCopy(host, "Copy every path in this list");
    expect(clipboardWrites()).toEqual(["src/components/a.tsx\nsrc/components/b.tsx\nREADME.md"]);
  });

  it("counts a single file in the singular", async () => {
    changes = [{ path: "README.md", status: "added", additions: 1, deletions: 0 }];
    const host = await mount();
    expect(host.textContent).toContain("1 changed file");
    expect(host.textContent).not.toContain("1 changed files");
  });

  // The checks view is what gets handed to someone in chat when CI goes red, so
  // the copy carries the rollup, the counts and the PR's link.
  it("copies the check summary and the PR link", async () => {
    const host = await mount(
      () => {},
      () => {},
      {
        ...REPO,
        pr: {
          ...POLLED_PR,
          checkRollup: "failure",
          checks: { total: 4, success: 3, failure: 1, pending: 0 },
        },
      },
    );
    await clickTab(host, "PR checks");
    await clickCopy(host, "Copy the check summary and the PR link");
    expect(clipboardWrites()).toEqual([
      "web #12 · ✗ checks failing · 3 passing · 1 failing\nhttps://github.com/octo/web/pull/12",
    ]);

    resetClipboardWrites();
    await clickCopy(host, "Copy the link to web #12");
    expect(clipboardWrites()).toEqual(["https://github.com/octo/web/pull/12"]);
  });

  it("reaches the self-review comments through their own tab", async () => {
    const host = await mount();
    await clickTab(host, "Comments");
    expect(host.textContent).toContain("No comments yet.");
    // With none open, the tab carries no count beside its label.
    const tab = [...host.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Comments"),
    );
    expect(tab?.textContent).toBe("Comments");
  });
});
