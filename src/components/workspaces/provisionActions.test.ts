import { describe, expect, it } from "bun:test";
import type {
  WorkspaceDetail,
  WorkspaceRepoDetail,
  WorkspaceRepoStatus,
  WorkspaceStatus,
} from "../../lib/workspaces";
import { provisionActions, setupLogToAutoOpen } from "./provisionActions";

function repo(status: WorkspaceRepoStatus, name = "widget"): WorkspaceRepoDetail {
  return {
    id: `wr-${name}`,
    workspaceId: "ws1",
    repoId: `r-${name}`,
    status,
    branch: "yarvis/task",
    existingBranch: false,
    baseBranch: "main",
    worktreePath: `/work/ws1/${name}`,
    setupLog: null,
    setupExitCode: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    repo: {
      id: `r-${name}`,
      name,
      owner: "acme",
      repo: name,
      cloneUrl: `git@github.com:acme/${name}.git`,
      defaultBranch: "main",
      primaryClonePath: `/work/.repos/acme-${name}`,
      setupScript: null,
      runScript: null,
      pullIssues: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    pr: null,
  };
}

function workspace(status: WorkspaceStatus, repos: WorkspaceRepoDetail[]): WorkspaceDetail {
  return {
    id: "ws1",
    name: "task",
    slug: "task",
    status,
    rootPath: "/work/ws1",
    summary: null,
    mergedPrUrl: null,
    error: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    repos,
    tasks: [],
    issues: [],
  };
}

describe("setupLogToAutoOpen", () => {
  it("opens the failed repo's log for a workspace parked on the failure", () => {
    const detail = workspace("error", [repo("ready", "a"), repo("error", "b")]);
    expect(setupLogToAutoOpen(detail, false)).toEqual({ workspaceRepoId: "wr-b", title: "b" });
  });

  it("stops opening it once the failure has been ignored", () => {
    // Ignoring is what flips the workspace back to `active`; the repo still
    // reads as failed, and that must no longer be the first thing on screen.
    const detail = workspace("active", [repo("error", "b")]);
    expect(setupLogToAutoOpen(detail, false)).toBeNull();
  });

  it("leaves a failed teardown to the archive, which raises its own attention", () => {
    const detail = workspace("archiving", [repo("error", "b")]);
    expect(setupLogToAutoOpen(detail, false)).toBeNull();
  });

  it("opens once per visit, not on every poll", () => {
    const detail = workspace("error", [repo("error", "b")]);
    expect(setupLogToAutoOpen(detail, true)).toBeNull();
  });

  it("has nothing to open before the workspace has loaded", () => {
    expect(setupLogToAutoOpen(null, false)).toBeNull();
  });
});

describe("provisionActions", () => {
  it("offers the first provision of a workspace that has none", () => {
    expect(provisionActions(workspace("creating", [repo("pending")]))).toEqual({
      show: true,
      label: "Provision worktrees",
      showIgnore: false,
    });
  });

  it("calls it creating a folder when there are no repos to cut", () => {
    expect(provisionActions(workspace("creating", [])).label).toBe("Create folder");
  });

  it("offers both the retry and the ignore on a failed provision", () => {
    expect(provisionActions(workspace("error", [repo("error")]))).toEqual({
      show: true,
      label: "Retry provisioning",
      showIgnore: true,
    });
  });

  it("keeps the retry after the error is ignored, since the repo still has no worktree", () => {
    expect(provisionActions(workspace("active", [repo("error")]))).toEqual({
      show: true,
      label: "Retry provisioning",
      showIgnore: false,
    });
  });

  it("offers nothing once every repo is ready", () => {
    expect(provisionActions(workspace("active", [repo("ready")])).show).toBe(false);
  });

  it("does not offer to provision a workspace whose teardown failed", () => {
    // Its repos land in `error` the same way, but that failure is the archive's
    // to retry — see the header's "Retry archive".
    expect(provisionActions(workspace("archiving", [repo("error")])).label).not.toBe(
      "Retry provisioning",
    );
    expect(provisionActions(workspace("archiving", [repo("error")])).showIgnore).toBe(false);
  });
});
