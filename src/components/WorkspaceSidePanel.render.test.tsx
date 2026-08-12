import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChangedFile, WorkspaceRepoDetail } from "../lib/workspaces";
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

let unmount: (() => void) | null = null;

beforeEach(() => {
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

const mount = async (onOpenFile: (repoId: string, path: string) => void = () => {}) => {
  const mounted = await mountForInteraction(
    <WorkspaceSidePanel workspaceId="ws-1" repos={[REPO]} onOpenFile={onOpenFile} />,
  );
  unmount = mounted.unmount;
  return mounted.host;
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
    expect(host.querySelector('details ul [title="src/components/b.tsx"]')).not.toBeNull();
    expect(host.innerHTML).not.toContain(">src/components/b.tsx<");
  });

  it("keeps the empty states of both views", async () => {
    files = [];
    changes = [];
    const host = await mount();
    expect(host.textContent).toContain("No changes on this branch.");
    await clickTab(host, "All files");
    expect(host.textContent).toContain("No files.");
  });
});
