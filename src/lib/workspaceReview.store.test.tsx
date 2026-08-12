import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { useState } from "react";
import { mountForInteraction } from "../test/render";
import type { ReviewComment } from "./workspaceReview";

/**
 * The store behind `useReviewComments`: the diff tab and the comments list read
 * the same workspace through it, so a write in one has to land in the other.
 * These tests mount two probes on one workspace id rather than any real view.
 */

let stored: Record<string, ReviewComment[]> = {};
let loadCount = 0;
const deleted: string[] = [];

const actual = await import("./workspaceReview");
mock.module("./workspaceReview", () => ({
  ...actual,
  listReviewComments: async (workspaceId: string) => {
    loadCount++;
    return stored[workspaceId] ?? [];
  },
  deleteReviewComment: async (_workspaceId: string, commentId: string) => {
    deleted.push(commentId);
  },
}));

const { useReviewComments } = await import("./workspaceReview");

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c-1",
  workspaceRepoId: "wr-1",
  path: "src/a.ts",
  startLine: 1,
  endLine: 1,
  commitSha: null,
  body: "Note.",
  resolvedAt: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  ...over,
});

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** Renders one workspace's comment bodies, and exposes its `remove`. */
function Probe({ workspaceId, label }: { workspaceId: string; label: string }) {
  const { comments, remove } = useReviewComments(workspaceId);
  return (
    <div>
      <span data-testid={label}>{comments.map((c) => c.body).join("|")}</span>
      <button type="button" onClick={() => void remove("c-1")}>
        {`remove-${label}`}
      </button>
    </div>
  );
}

const read = (host: HTMLElement, label: string) =>
  host.querySelector(`[data-testid="${label}"]`)?.textContent;

let unmount: (() => void) | null = null;

beforeEach(() => {
  stored = { "ws-1": [comment()], "ws-2": [comment({ id: "c-2", body: "Other workspace." })] };
  loadCount = 0;
  deleted.length = 0;
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("useReviewComments", () => {
  it("shows one workspace's comments to every view of it", async () => {
    const mounted = await mountForInteraction(
      <>
        <Probe workspaceId="ws-1" label="diff" />
        <Probe workspaceId="ws-1" label="list" />
      </>,
    );
    unmount = mounted.unmount;
    expect(read(mounted.host, "diff")).toBe("Note.");
    expect(read(mounted.host, "list")).toBe("Note.");
  });

  it("makes one request for a workspace two views mount on at once", async () => {
    const mounted = await mountForInteraction(
      <>
        <Probe workspaceId="ws-1" label="diff" />
        <Probe workspaceId="ws-1" label="list" />
      </>,
    );
    unmount = mounted.unmount;
    expect(loadCount).toBe(1);
  });

  it("lands a delete made in one view in the other", async () => {
    const mounted = await mountForInteraction(
      <>
        <Probe workspaceId="ws-1" label="diff" />
        <Probe workspaceId="ws-1" label="list" />
      </>,
    );
    unmount = mounted.unmount;

    const button = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "remove-list",
    );
    button?.click();
    await settle();

    expect(deleted).toEqual(["c-1"]);
    expect(read(mounted.host, "list")).toBe("");
    expect(read(mounted.host, "diff")).toBe("");
  });

  // The side panel is not remounted when the user switches workspaces — the
  // prop changes in place — so the list has to follow the id, not the mount.
  it("follows a changed workspace id rather than showing the previous one", async () => {
    function Switcher() {
      const [workspaceId, setWorkspaceId] = useState("ws-1");
      return (
        <div>
          <Probe workspaceId={workspaceId} label="panel" />
          <button type="button" onClick={() => setWorkspaceId("ws-2")}>
            switch
          </button>
        </div>
      );
    }
    const mounted = await mountForInteraction(<Switcher />);
    unmount = mounted.unmount;
    expect(read(mounted.host, "panel")).toBe("Note.");

    const button = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "switch",
    );
    button?.click();
    await settle();

    expect(read(mounted.host, "panel")).toBe("Other workspace.");
  });
});
