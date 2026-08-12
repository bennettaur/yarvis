import { afterEach, describe, expect, it } from "bun:test";
import type { CreateReviewCommentInput, ReviewComment } from "../../lib/workspaceReview";
import { mountForInteraction } from "../../test/render";
import ReviewDiffBody from "./ReviewDiffBody";

const PATCH = [
  "@@ -1,3 +1,5 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
].join("\n");

const COMMENT: ReviewComment = {
  id: "c-1",
  workspaceRepoId: "wr-1",
  path: "src/a.ts",
  startLine: 2,
  endLine: 3,
  commitSha: "abc1234def",
  body: "Fold these together.",
  resolvedAt: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

const mount = async (
  comments: ReviewComment[],
  onAdd: (input: CreateReviewCommentInput) => Promise<void> = async () => {},
) => {
  const mounted = await mountForInteraction(
    <ReviewDiffBody
      patch={PATCH}
      path="src/a.ts"
      workspaceRepoId="wr-1"
      comments={comments}
      onAdd={onAdd}
      onToggleResolved={() => {}}
      onDelete={() => {}}
    />,
  );
  unmount = mounted.unmount;
  return mounted.host;
};

/** The line-number gutters, in render order — the drag handles under test. */
const gutters = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>("span.cursor-ns-resize"),
];

const drag = async (host: HTMLElement, fromIndex: number, toIndex: number) => {
  const cells = gutters(host);
  cells[fromIndex]?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  // Each step settles before the next: the window-level mouseup listener is
  // only attached once React has committed the mousedown that starts the drag,
  // which for a real pointer is always several frames earlier.
  await settle();
  cells[toIndex]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await settle();
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await settle();
};

describe("ReviewDiffBody", () => {
  it("hangs an existing comment under the last line of its range", async () => {
    const host = await mount([COMMENT]);
    expect(host.textContent).toContain("Fold these together.");
    expect(host.textContent).toContain("line 2-3");
  });

  it("opens a composer for the single line a plain click lands on", async () => {
    const host = await mount([]);
    await drag(host, 0, 0);
    expect(host.textContent).toContain("Line 1");
  });

  it("opens a composer covering every line a drag crossed", async () => {
    const host = await mount([]);
    // Gutter 0 is the context line 1; gutter 2 is the second added line, 3.
    await drag(host, 0, 2);
    expect(host.textContent).toContain("Lines 1–3");
  });

  it("saves the dragged range as the comment's line span", async () => {
    const saved: CreateReviewCommentInput[] = [];
    const host = await mount([], async (input) => {
      saved.push(input);
    });
    await drag(host, 1, 2);

    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("no composer");
    // React tracks the last value it wrote, so a direct assignment looks like a
    // no-op to it — go through the prototype setter it doesn't shadow.
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setValue?.call(textarea, "Squash these.");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const save = [...host.querySelectorAll("button")].find((b) => b.textContent === "Save comment");
    save?.click();
    await settle();

    expect(saved).toEqual([
      {
        workspaceRepoId: "wr-1",
        path: "src/a.ts",
        startLine: 2,
        endLine: 3,
        body: "Squash these.",
      },
    ]);
  });
});
