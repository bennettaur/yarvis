import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReviewComment } from "../../lib/workspaceReview";
import type { WorkspaceRepoDetail } from "../../lib/workspaces";
import { mountForInteraction } from "../../test/render";

/**
 * The clipboard itself is left alone here: `CopyPathButton.test.tsx` owns the
 * `@tauri-apps/api/core` mock for the run, and a second suite claiming it would
 * take the command out from under that one. What the copy button hands over is
 * `formatReviewComments`, covered in `lib/workspaceReview.test.ts`; this suite
 * checks when it is offered at all.
 */
let stored: ReviewComment[] = [];
const patched: { id: string; resolved?: boolean }[] = [];
const deleted: string[] = [];

const actualReview = await import("../../lib/workspaceReview");
mock.module("../../lib/workspaceReview", () => ({
  ...actualReview,
  listReviewComments: async () => stored,
  updateReviewComment: async (_ws: string, id: string, patch: { resolved?: boolean }) => {
    patched.push({ id, ...patch });
    const found = stored.find((c) => c.id === id);
    if (!found) throw new Error("no such comment");
    return { ...found, resolvedAt: patch.resolved ? "2026-06-01T10:00:00.000Z" : null };
  },
  deleteReviewComment: async (_ws: string, id: string) => {
    deleted.push(id);
  },
}));

const { default: WorkspaceReviewComments } = await import("./WorkspaceReviewComments");

const REPO = {
  id: "wr-1",
  repo: { name: "web" },
} as WorkspaceRepoDetail;

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c-1",
  workspaceRepoId: "wr-1",
  path: "src/a.ts",
  startLine: 4,
  endLine: 4,
  commitSha: "abc1234def",
  body: "Rename this.",
  resolvedAt: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  ...over,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let unmount: (() => void) | null = null;

beforeEach(() => {
  stored = [comment()];
  patched.length = 0;
  deleted.length = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
  // A module mock outlives the file that registered it, and `WorkspaceSidePanel`
  // reads the same hook for its tab badge. Emptying the list here means a suite
  // running after this one sees no comments however the files are ordered.
  stored = [];
});

const mount = async (onOpenFile: (repoId: string, path: string) => void = () => {}) => {
  const mounted = await mountForInteraction(
    <WorkspaceReviewComments workspaceId="ws-1" repos={[REPO]} onOpenFile={onOpenFile} />,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

const clickButton = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no ${label} button`);
  button.click();
  await settle();
};

describe("WorkspaceReviewComments", () => {
  it("lists each comment with its file and lines", async () => {
    const host = await mount();
    expect(host.textContent).toContain("src/a.ts:4");
    expect(host.textContent).toContain("Rename this.");
    expect(host.textContent).toContain("1 open");
  });

  it("names the repo only when the workspace has more than one", async () => {
    const host = await mount();
    expect(host.textContent).not.toContain("web/src/a.ts");
  });

  it("offers the copy only while something is open to paste", async () => {
    const host = await mount();
    const copyButton = () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Copy"));
    expect(copyButton()?.disabled).toBe(false);

    await clickButton(host, "Resolve");
    expect(patched).toEqual([{ id: "c-1", resolved: true }]);
    expect(host.textContent).toContain("0 open");
    expect(copyButton()?.disabled).toBe(true);
  });

  it("keeps a resolved comment listed rather than hiding the decision", async () => {
    const host = await mount();
    await clickButton(host, "Resolve");
    expect(host.textContent).toContain("Rename this.");
    expect(host.textContent).toContain("resolved");
    expect(host.textContent).toContain("1 resolved");
  });

  it("deletes a comment", async () => {
    const host = await mount();
    await clickButton(host, "×");
    expect(deleted).toEqual(["c-1"]);
    expect(host.textContent).toContain("No comments yet.");
  });

  it("opens the diff the comment was left on", async () => {
    const opened: string[] = [];
    const host = await mount((repoId, path) => opened.push(`${repoId}:${path}`));
    await clickButton(host, "src/a.ts:4");
    expect(opened).toEqual(["wr-1:src/a.ts"]);
  });
});
